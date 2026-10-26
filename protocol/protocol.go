package protocol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/bundled"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
	"github.com/microsoft/TypeScript/tsc/internal/collections"
	"github.com/microsoft/TypeScript/tsc/internal/compiler"
	"github.com/microsoft/TypeScript/tsc/internal/contentmapper"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/diagnosticwriter"
	"github.com/microsoft/TypeScript/tsc/internal/execute/incremental"
	"github.com/microsoft/TypeScript/tsc/internal/locale"
	"github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/transpile"
	"github.com/microsoft/TypeScript/tsc/internal/tsoptions"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
	"github.com/microsoft/TypeScript/tsc/internal/vfs/osvfs"
)

type Request struct {
	ID              uint64          `json:"id"`
	Method          string          `json:"method"`
	Source          string          `json:"source"`
	FileName        string          `json:"fileName"`
	ConfigPath      string          `json:"configPath"`
	Entrypoints     []string        `json:"entrypoints"`
	Files           []string        `json:"files"`
	CompilerOptions json.RawMessage `json:"compilerOptions"`
	RunExternalCode bool            `json:"runExternalCode"`
}

type Diagnostic struct {
	Code        int32        `json:"code"`
	Category    int          `json:"category"`
	Message     string       `json:"message"`
	MessageText string       `json:"messageText"`
	FileName    string       `json:"fileName,omitempty"`
	Start       int          `json:"start"`
	Length      int          `json:"length"`
	Children    []Diagnostic `json:"children,omitempty"`
}

type CodeUnion struct {
	Name  string   `json:"name"`
	Codes []string `json:"codes"`
}

type Response struct {
	ID          uint64       `json:"id"`
	Error       string       `json:"error,omitempty"`
	OutputText  string       `json:"outputText"`
	Diagnostics []Diagnostic `json:"diagnostics"`
	Unions      []CodeUnion  `json:"unions"`
}

type placedDiagnostic struct {
	*diagnosticwriter.ASTDiagnostic
}

func (d placedDiagnostic) MessageChain() []diagnosticwriter.Diagnostic {
	chain := d.Diagnostic.MessageChain()
	result := make([]diagnosticwriter.Diagnostic, 0, len(chain))
	for _, item := range chain {
		result = append(result, diagnosticwriter.WrapASTDiagnostic(item))
	}
	return result
}

func diagnostic(item *ast.Diagnostic, span *sourceSpan) Diagnostic {
	located := diagnosticwriter.WrapASTDiagnostic(item)
	var message diagnosticwriter.Diagnostic = located
	start, length := located.Pos(), located.Len()
	if span != nil {
		message = placedDiagnostic{located}
		start, length = span.Start, span.Length
	}
	d := Diagnostic{
		Code: item.Code(), Category: int(item.Category()),
		Message:     item.Localize(locale.Default),
		MessageText: diagnosticwriter.FlattenDiagnosticMessage(message, "\n", locale.Default),
		Start:       start, Length: length,
		Children: diagnostics(item.MessageChain()),
	}
	if item.File() != nil {
		d.FileName = item.File().FileName().AsString()
	}
	return d
}

func diagnostics(items []*ast.Diagnostic) []Diagnostic {
	result := make([]Diagnostic, 0, len(items))
	for _, item := range items {
		result = append(result, diagnostic(item, nil))
	}
	return result
}

func verifiedDiagnostics(items []*ast.Diagnostic, spans map[*ast.Diagnostic]*sourceSpan) []Diagnostic {
	result := make([]Diagnostic, 0, len(items))
	for _, item := range items {
		span, verified := spans[item]
		if verified && span == nil {
			continue
		}
		result = append(result, diagnostic(item, span))
	}
	return result
}

type cachedSourceFile struct {
	text string
	file *ast.SourceFile
}

type cachingHost struct {
	compiler.CompilerHost
	files  *collections.SyncMap[tspath.PathKey, *cachedSourceFile]
	mapped *collections.SyncMap[tspath.PathKey, *cachedMappedFiles]
}

func (h *cachingHost) GetSourceFile(opts ast.SourceFileParseOptions) *ast.SourceFile {
	text, ok := h.FS().ReadFile(opts.FileName)
	if !ok {
		h.files.Delete(opts.PathKey)
		return nil
	}
	if cached, ok := h.files.Load(opts.PathKey); ok && cached.text == text && cached.file.ParseOptions() == opts {
		return cached.file
	}
	file := parser.ParseSourceFile(opts, text, core.EnsureScriptKindFromFileName(opts.FileName))
	h.files.Store(opts.PathKey, &cachedSourceFile{text: text, file: file})
	return file
}

type project struct {
	files   collections.SyncMap[tspath.PathKey, *cachedSourceFile]
	mapped  collections.SyncMap[tspath.PathKey, *cachedMappedFiles]
	mappers contentmapper.Project
	program *incremental.Program
}

var (
	projectsMu sync.Mutex
	projects   = map[string]*project{}
)

func projectKey(configPath string, req Request) (string, error) {
	key, err := json.Marshal([]any{configPath, req.Files, req.CompilerOptions, req.RunExternalCode})
	return string(key), err
}

func parseConfig(configPath string, req Request, host tsoptions.ParseConfigHost) (*tsoptions.ParsedCommandLine, []*ast.Diagnostic, error) {
	options := &core.CompilerOptions{NoEmit: core.TSTrue}
	if req.RunExternalCode {
		options.RunExternalCode = core.TSTrue
	}
	if req.Files == nil && len(req.CompilerOptions) == 0 {
		config, parseErrors := tsoptions.GetParsedCommandLineOfConfigFile(tspath.RootedFilePathFromAbsolute(configPath), options, nil, host, nil)
		return config, parseErrors, nil
	}
	overlay := map[string]any{"extends": filepath.ToSlash(configPath)}
	if len(req.CompilerOptions) != 0 {
		overlay["compilerOptions"] = req.CompilerOptions
	}
	if req.Files != nil {
		overlay["files"] = req.Files
		overlay["include"] = []string{}
	}
	text, err := json.Marshal(overlay)
	if err != nil {
		return nil, nil, err
	}
	dir := tspath.RootedDirectoryPathFromAbsolute(filepath.Dir(configPath))
	name := dir.ResolveFile("tsconfig.bridge.json")
	source := tsoptions.NewTsconfigSourceFileFromFilePath(
		name, host.FS().CaseSensitivity().PathKey(name.AsPath()), string(text),
	)
	return tsoptions.ParseJsonSourceFileConfigFileContent(source, host, dir, options, nil, nil, nil), nil, nil
}

func loadProgram(req Request) (*incremental.Program, []*ast.Diagnostic, error) {
	if req.ConfigPath == "" {
		return nil, nil, errors.New("configPath is required")
	}
	configPath, err := filepath.Abs(req.ConfigPath)
	if err != nil {
		return nil, nil, err
	}
	key, err := projectKey(configPath, req)
	if err != nil {
		return nil, nil, err
	}
	state := projects[key]
	if state == nil {
		state = &project{}
		projects[key] = state
	}
	fs := bundled.WrapFS(osvfs.FS())
	config, parseErrors, err := parseConfig(configPath, req, tsoptions.NewDefaultParseConfigHost(fs))
	if err != nil || config == nil || len(parseErrors) != 0 {
		return nil, parseErrors, err
	}
	var mappers contentmapper.Project
	if len(config.ContentMappers()) != 0 {
		mappers = mapperHost().Project(contentmapper.ProjectSpec{
			ConfigFileName:  tspath.RootedFilePathFromAbsolute(configPath),
			Mappers:         config.ContentMappers(),
			CompilerOptions: config.CompilerOptions(),
		})
	}
	host := &cachingHost{
		CompilerHost: compiler.NewCompilerHost(fs, bundled.LibPath(), nil, nil, mappers),
		files:        &state.files,
		mapped:       &state.mapped,
	}
	state.program = incremental.NewProgram(compiler.NewProgram(compiler.ProgramOptions{
		Config: config, SingleThreaded: core.TSTrue, Host: host,
	}), state.program, nil, time.Now, false)
	if state.mappers != nil {
		state.mappers.Close()
	}
	state.mappers = mappers
	return state.program, nil, nil
}

func collectCodeUnions(ctx context.Context, program *compiler.Program, req Request) ([]CodeUnion, error) {
	if len(req.Entrypoints) == 0 {
		return nil, errors.New("entrypoints must not be empty")
	}
	program.BindSourceFiles()
	c, release := program.GetTypeChecker(ctx)
	defer release()
	byName := make(map[string][]string)
	for _, entry := range req.Entrypoints {
		if !filepath.IsAbs(entry) {
			entry = filepath.Join(filepath.Dir(req.ConfigPath), entry)
		}
		absolute, err := filepath.Abs(entry)
		if err != nil {
			return nil, err
		}
		source := program.GetSourceFile(tspath.RootedFilePathFromAbsolute(absolute))
		if source == nil {
			return nil, fmt.Errorf("entrypoint is not in the project: %s", entry)
		}
		module := c.GetSymbolAtLocation(source.AsNode())
		if module == nil {
			return nil, fmt.Errorf("entrypoint is not a module: %s", entry)
		}
		for _, exported := range c.GetExportsOfModule(module) {
			name := exported.Name()
			if !strings.HasSuffix(name, "ErrorCode") && !strings.HasSuffix(name, "ReasonCode") {
				continue
			}
			symbol := exported
			if symbol.Flags()&ast.SymbolFlagsAlias != 0 {
				symbol = c.GetAliasedSymbol(symbol)
			}
			declared := c.GetDeclaredTypeOfSymbol(symbol)
			parts := []*checker.Type{declared}
			if declared.Flags()&checker.TypeFlagsUnion != 0 {
				parts = declared.Types()
			}
			codes := make([]string, 0, len(parts))
			for _, part := range parts {
				if part.Flags()&checker.TypeFlagsStringLiteral != 0 {
					if value, ok := part.AsLiteralType().Value().(string); ok {
						codes = append(codes, value)
					}
				}
			}
			if len(codes) == 0 {
				continue
			}
			slices.Sort(codes)
			codes = slices.Compact(codes)
			if previous, exists := byName[name]; exists && !slices.Equal(previous, codes) {
				return nil, fmt.Errorf("conflicting exported unions named %s", name)
			}
			byName[name] = codes
		}
	}
	result := make([]CodeUnion, 0, len(byName))
	for name, codes := range byName {
		result = append(result, CodeUnion{Name: name, Codes: codes})
	}
	slices.SortFunc(result, func(a, b CodeUnion) int { return strings.Compare(a.Name, b.Name) })
	return result, nil
}

func Handle(req Request) Response {
	result := Response{ID: req.ID, Diagnostics: []Diagnostic{}, Unions: []CodeUnion{}}
	ctx := context.Background()
	if req.Method == "transpile" {
		output := transpile.TranspileModule(ctx, req.Source, transpile.Options{
			FileName: req.FileName, ReportDiagnostics: true,
			CompilerOptions: &core.CompilerOptions{Target: core.ScriptTargetESNext, Module: core.ModuleKindESNext},
		})
		if output == nil {
			result.Error = "transpilation canceled"
			return result
		}
		result.OutputText = output.OutputText
		result.Diagnostics = diagnostics(output.Diagnostics)
		return result
	}
	if req.Method != "checkProject" && req.Method != "exportedCodeUnions" {
		result.Error = fmt.Sprintf("unknown method: %s", req.Method)
		return result
	}
	projectsMu.Lock()
	defer projectsMu.Unlock()
	program, parseErrors, err := loadProgram(req)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if program == nil {
		result.Diagnostics = diagnostics(parseErrors)
		if req.Method == "exportedCodeUnions" {
			result.Error = "cannot extract unions from an invalid project configuration"
		}
		return result
	}
	if req.Method == "exportedCodeUnions" {
		result.Unions, err = collectCodeUnions(ctx, program.GetProgram(), req)
		if err != nil {
			result.Error = err.Error()
		}
		return result
	}
	items := program.GetConfigFileParsingDiagnostics()
	items = append(items, program.GetProgramDiagnostics()...)
	items = append(items, program.GetSyntacticDiagnostics(ctx, nil)...)
	items = append(items, program.GetGlobalDiagnostics(ctx)...)
	items = append(items, program.GetSemanticDiagnostics(ctx, nil)...)
	slices.SortFunc(items, ast.CompareDiagnostics)
	items = slices.CompactFunc(items, ast.EqualDiagnostics)
	configPath, err := filepath.Abs(req.ConfigPath)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	spans, err := verifyContentMapped(program.GetProgram(), configPath, items)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Diagnostics = verifiedDiagnostics(items, spans)
	return result
}
