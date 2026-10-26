package protocol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/compiler"
	"github.com/microsoft/TypeScript/tsc/internal/contentmapper"
	"github.com/microsoft/TypeScript/tsc/internal/jsonrpc"
	"github.com/microsoft/TypeScript/tsc/internal/locale"
)

type mapperProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.Reader
}

type Spawner func(command []string, dir string, stderr io.Writer) (io.ReadWriteCloser, error)

var spawn Spawner = startProcess

func SetSpawner(spawner Spawner) {
	spawn = spawner
}

func startProcess(command []string, dir string, stderr io.Writer) (io.ReadWriteCloser, error) {
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = dir
	cmd.Stderr = stderr
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &mapperProcess{cmd: cmd, stdin: stdin, stdout: stdout}, nil
}

func (p *mapperProcess) Read(b []byte) (int, error)  { return p.stdout.Read(b) }
func (p *mapperProcess) Write(b []byte) (int, error) { return p.stdin.Write(b) }

func (p *mapperProcess) ExitCode() (int, bool) {
	if p.cmd.ProcessState == nil {
		return 0, false
	}
	return p.cmd.ProcessState.ExitCode(), true
}

func (p *mapperProcess) Close() error {
	_ = p.stdin.Close()
	_ = p.cmd.Process.Kill()
	err := p.cmd.Wait()
	if _, ok := errors.AsType[*exec.ExitError](err); ok || errors.Is(err, exec.ErrWaitDelay) {
		return nil
	}
	return err
}

type mapperSpawner struct{}

func (mapperSpawner) Spawn(command []string, dir string, stderr io.Writer) (io.ReadWriteCloser, error) {
	if len(command) == 0 {
		return nil, errors.New("content mapper command is empty")
	}
	return spawn(command, dir, stderr)
}

var mapperHost = sync.OnceValue(func() contentmapper.Host {
	return contentmapper.NewHost(context.Background(), mapperSpawner{}, locale.Default)
})

type cachedMappedFiles struct {
	text     string
	identity string
	files    contentmapper.SourceFiles
}

func (h *cachingHost) GetContentMappedSourceFiles(opts ast.SourceFileParseOptions, mapper *contentmapper.Mapper) (contentmapper.SourceFiles, error) {
	project := h.ContentMapperProject()
	text, ok := h.FS().ReadFile(opts.FileName)
	if !ok || project == nil {
		h.mapped.Delete(opts.PathKey)
		return h.CompilerHost.GetContentMappedSourceFiles(opts, mapper)
	}
	identity, err := project.Identity(mapper)
	if err != nil {
		return h.CompilerHost.GetContentMappedSourceFiles(opts, mapper)
	}
	if cached, ok := h.mapped.Load(opts.PathKey); ok && cached.text == text && cached.identity == identity &&
		cached.files.Canonical.ParseOptions() == opts {
		return cached.files, nil
	}
	files, err := h.CompilerHost.GetContentMappedSourceFiles(opts, mapper)
	if err == nil && files.Canonical != nil {
		h.mapped.Store(opts.PathKey, &cachedMappedFiles{text: text, identity: identity, files: files})
	}
	return files, err
}

type bridgeManifest struct {
	TscBridge struct {
		Verify bool `json:"verify"`
	} `json:"tscBridge"`
}

type verifier struct {
	process io.ReadWriteCloser
	reader  *jsonrpc.Reader
	writer  *jsonrpc.Writer
	nextID  int
}

var verifiers = map[string]*verifier{}

func verifierKey(mapper *contentmapper.Mapper) string {
	return strings.Join(append([]string{mapper.PackageDirectory.AsString()}, mapper.Exec...), "\x00")
}

func verifierFor(mapper *contentmapper.Mapper) (*verifier, error) {
	key := verifierKey(mapper)
	if v, ok := verifiers[key]; ok {
		return v, nil
	}
	data, err := os.ReadFile(filepath.Join(mapper.PackageDirectory.AsString(), "package.json"))
	if err != nil {
		return nil, err
	}
	var manifest bridgeManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("content mapper %s: %w", mapper.DiagnosticName(), err)
	}
	if !manifest.TscBridge.Verify {
		verifiers[key] = nil
		return nil, nil
	}
	process, err := mapperSpawner{}.Spawn(mapper.Exec, mapper.PackageDirectory.AsString(), os.Stderr)
	if err != nil {
		return nil, fmt.Errorf("content mapper %s: %w", mapper.DiagnosticName(), err)
	}
	v := &verifier{process: process, reader: jsonrpc.NewReader(process), writer: jsonrpc.NewWriter(process)}
	verifiers[key] = v
	return v, nil
}

func (v *verifier) call(method string, params any, result any) error {
	v.nextID++
	request, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": v.nextID, "method": method, "params": params})
	if err != nil {
		return err
	}
	if err := v.writer.Write(request); err != nil {
		return err
	}
	payload, err := v.reader.Read()
	if err != nil {
		return err
	}
	var response struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &response); err != nil {
		return err
	}
	if response.ID != v.nextID {
		return fmt.Errorf("content mapper answered request %d with %d", v.nextID, response.ID)
	}
	if response.Error != nil {
		return errors.New(response.Error.Message)
	}
	return json.Unmarshal(response.Result, result)
}

type verifyDiagnostic struct {
	Start  int    `json:"start"`
	Length int    `json:"length"`
	Code   int32  `json:"code"`
	Source string `json:"source,omitempty"`
}

type verifyFile struct {
	FileName    string             `json:"fileName"`
	Content     string             `json:"content"`
	VirtualText string             `json:"virtualText"`
	Diagnostics []verifyDiagnostic `json:"diagnostics"`
}

type verifyParams struct {
	ConfigFileName string          `json:"configFileName"`
	Options        json.RawMessage `json:"options,omitempty"`
	Files          []verifyFile    `json:"files"`
}

type sourceSpan struct {
	Start  int `json:"start"`
	Length int `json:"length"`
}

func utf16Offset(text string, offset int) int {
	units := 0
	for _, r := range text[:min(offset, len(text))] {
		units += utf16Len(r)
	}
	return units
}

func utf8Offset(text string, units int) int {
	counted := 0
	for i, r := range text {
		if counted >= units {
			return i
		}
		counted += utf16Len(r)
	}
	return len(text)
}

func utf16Len(r rune) int {
	if r >= 0x10000 && r <= utf8.MaxRune {
		return 2
	}
	return 1
}

type mappedFile struct {
	file  *ast.SourceFile
	items []*ast.Diagnostic
}

type mapperBatch struct {
	mapper   *contentmapper.Mapper
	verifier *verifier
	files    []*mappedFile
}

func verifyContentMapped(program *compiler.Program, configPath string, items []*ast.Diagnostic) (map[*ast.Diagnostic]*sourceSpan, error) {
	var batches []*mapperBatch
	for _, item := range items {
		file := item.File()
		if file == nil || item.Source() != "" {
			continue
		}
		mapper := program.GetContentMapper(file)
		if mapper == nil {
			continue
		}
		v, err := verifierFor(mapper)
		if err != nil {
			return nil, err
		}
		if v == nil {
			continue
		}
		i := slices.IndexFunc(batches, func(b *mapperBatch) bool { return b.mapper == mapper })
		if i < 0 {
			batches = append(batches, &mapperBatch{mapper: mapper, verifier: v})
			i = len(batches) - 1
		}
		batch := batches[i]
		j := slices.IndexFunc(batch.files, func(f *mappedFile) bool { return f.file == file })
		if j < 0 {
			batch.files = append(batch.files, &mappedFile{file: file})
			j = len(batch.files) - 1
		}
		batch.files[j].items = append(batch.files[j].items, item)
	}
	spans := make(map[*ast.Diagnostic]*sourceSpan)
	for _, batch := range batches {
		params := verifyParams{ConfigFileName: filepath.ToSlash(configPath), Files: make([]verifyFile, 0, len(batch.files))}
		if len(batch.mapper.Options) != 0 {
			params.Options = json.RawMessage(batch.mapper.Options)
		}
		for _, mapped := range batch.files {
			virtual := mapped.file.Text()
			file := verifyFile{
				FileName:    mapped.file.FileName().AsString(),
				Content:     mapped.file.OriginalText(),
				VirtualText: virtual,
				Diagnostics: make([]verifyDiagnostic, 0, len(mapped.items)),
			}
			for _, item := range mapped.items {
				start := utf16Offset(virtual, item.Pos())
				file.Diagnostics = append(file.Diagnostics, verifyDiagnostic{
					Start: start, Length: utf16Offset(virtual, item.End()) - start,
					Code: item.Code(), Source: item.Source(),
				})
			}
			params.Files = append(params.Files, file)
		}
		var results [][]*sourceSpan
		if err := batch.verifier.call("verify", params, &results); err != nil {
			batch.verifier.process.Close()
			delete(verifiers, verifierKey(batch.mapper))
			return nil, fmt.Errorf("content mapper %s: %w", batch.mapper.DiagnosticName(), err)
		}
		if len(results) != len(batch.files) {
			return nil, fmt.Errorf("content mapper %s verified %d of %d files", batch.mapper.DiagnosticName(), len(results), len(batch.files))
		}
		for i, mapped := range batch.files {
			if len(results[i]) != len(mapped.items) {
				return nil, fmt.Errorf("content mapper %s verified %d of %d diagnostics in %s",
					batch.mapper.DiagnosticName(), len(results[i]), len(mapped.items), mapped.file.FileName())
			}
			original := mapped.file.OriginalText()
			for k, span := range results[i] {
				if span == nil {
					spans[mapped.items[k]] = nil
					continue
				}
				start := utf8Offset(original, span.Start)
				spans[mapped.items[k]] = &sourceSpan{Start: start, Length: utf8Offset(original, span.Start+span.Length) - start}
			}
		}
	}
	return spans, nil
}
