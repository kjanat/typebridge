//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall/js"
	"time"

	"github.com/microsoft/TypeScript/tsc/internal/api/encoder"
	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/json"
	"github.com/microsoft/TypeScript/tsc/internal/locale"
	"github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/tsoptions"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
	"github.com/microsoft/TypeScript/tsc/internal/vfs"
)

type diagnostic struct {
	FileName    string `json:"fileName,omitzero"`
	Start       *int   `json:"start,omitzero"`
	Length      *int   `json:"length,omitzero"`
	Code        int32  `json:"code"`
	Category    int    `json:"category"`
	MessageText string `json:"messageText"`
}

type config struct {
	FileNames []tspath.RootedFilePath `json:"fileNames"`
	Options   *core.CompilerOptions   `json:"options"`
	Raw       any                     `json:"raw,omitzero"`
	Errors    []diagnostic            `json:"errors"`
}

func convert(items []*ast.Diagnostic) []diagnostic {
	result := make([]diagnostic, 0, len(items))
	for _, item := range items {
		converted := diagnostic{
			Code:        item.Code(),
			Category:    int(item.Category()),
			MessageText: item.Localize(locale.Default),
		}
		if file := item.File(); file != nil {
			size := len(file.Text())
			pos := max(0, min(item.Pos(), size))
			end := max(pos, min(item.End(), size))
			positions := file.GetPositionMap()
			start := positions.UTF8ToUTF16(pos)
			length := positions.UTF8ToUTF16(end) - start
			converted.FileName = file.FileName().AsString()
			converted.Start = &start
			converted.Length = &length
		}
		result = append(result, converted)
	}
	return result
}

func parse(fileName string, text string, kind core.ScriptKind, cwd string) (map[string]any, error) {
	path := tspath.RootedDirectoryPathFromAbsolute(cwd).ResolveFile(fileName)
	if kind == core.ScriptKindUnknown {
		kind = core.EnsureScriptKindFromFileName(path)
	}
	switch kind {
	case core.ScriptKindJS, core.ScriptKindJSX, core.ScriptKindTS, core.ScriptKindTSX, core.ScriptKindJSON:
	default:
		return nil, fmt.Errorf("invalid scriptKind %d", kind)
	}
	file := parser.ParseSourceFile(ast.SourceFileParseOptions{
		FileName: path,
		PathKey:  tspath.CaseSensitive.PathKey(path.AsPath()),
	}, text, kind)
	data, _, err := encoder.EncodeSourceFile(file)
	if err != nil {
		return nil, err
	}
	diagnostics, err := json.Marshal(convert(file.Diagnostics()))
	if err != nil {
		return nil, err
	}
	bytes := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(bytes, data)
	return map[string]any{"data": bytes, "diagnostics": string(diagnostics)}, nil
}

func toObject(fileName string, text string, cwd string) (map[string]any, error) {
	path := tspath.RootedDirectoryPathFromAbsolute(cwd).ResolveFile(fileName)
	value, errs := tsoptions.ParseConfigFileTextToJson(path, tspath.CaseSensitive.PathKey(path.AsPath()), text)
	object, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	diagnostics, err := json.Marshal(convert(errs))
	if err != nil {
		return nil, err
	}
	return map[string]any{"value": string(object), "diagnostics": string(diagnostics)}, nil
}

type hostFS struct {
	host js.Value
}

func (f hostFS) has(name string) bool {
	return f.host.Get(name).Type() == js.TypeFunction
}

func (f hostFS) UseCaseSensitiveFileNames() bool {
	if f.has("useCaseSensitiveFileNames") {
		return f.host.Call("useCaseSensitiveFileNames").Truthy()
	}
	return f.host.Get("useCaseSensitiveFileNames").Truthy()
}

func (f hostFS) CaseSensitivity() tspath.CaseSensitivity {
	if f.UseCaseSensitiveFileNames() {
		return tspath.CaseSensitive
	}
	return tspath.CaseInsensitive
}

func (f hostFS) FileExists(path tspath.RootedFilePath) bool {
	return f.host.Call("fileExists", path.AsString()).Truthy()
}

func (f hostFS) ReadFile(path tspath.RootedFilePath) (string, bool) {
	value := f.host.Call("readFile", path.AsString())
	if value.Type() != js.TypeObject {
		return "", false
	}
	return wtf8(value), true
}

func (f hostFS) DirectoryExists(path tspath.RootedDirectoryPath) bool {
	if !f.has("directoryExists") {
		return true
	}
	return f.host.Call("directoryExists", path.AsString()).Truthy()
}

func (f hostFS) Realpath(path tspath.RootedPath) tspath.RootedPath {
	if !f.has("realpath") {
		return path
	}
	return tspath.RootedPathFromAbsolute(f.host.Call("realpath", path.AsString()).String())
}

func stringArray(value js.Value) []string {
	if value.Type() != js.TypeObject {
		return nil
	}
	result := make([]string, value.Length())
	for i := range result {
		result[i] = value.Index(i).String()
	}
	return result
}

func (f hostFS) GetAccessibleEntries(path tspath.RootedDirectoryPath) vfs.Entries {
	if !f.has("getAccessibleFileSystemEntries") {
		return vfs.Entries{}
	}
	entries := f.host.Call("getAccessibleFileSystemEntries", path.AsString())
	return vfs.Entries{
		Files:       stringArray(entries.Get("files")),
		Directories: stringArray(entries.Get("directories")),
	}
}

func (f hostFS) Stat(path tspath.RootedPath) vfs.FileInfo {
	return nil
}

func (f hostFS) WriteFile(path tspath.RootedFilePath, data string) error {
	return errors.ErrUnsupported
}

func (f hostFS) AppendFile(path tspath.RootedFilePath, data string) error {
	return errors.ErrUnsupported
}

func (f hostFS) Remove(path tspath.RootedPath) error {
	return errors.ErrUnsupported
}

func (f hostFS) Chtimes(path tspath.RootedPath, aTime time.Time, mTime time.Time) error {
	return errors.ErrUnsupported
}

func parseConfig(fileName string, text string, basePath string, configFileName string, host js.Value) (map[string]any, error) {
	fs := hostFS{host: host}
	cwd := basePath
	if fs.has("getCurrentDirectory") {
		cwd = host.Call("getCurrentDirectory").String()
	}
	base := tspath.RootedDirectoryPathFromAbsolute(cwd).ResolveDirectory(basePath)
	path := tspath.RootedDirectoryPathFromAbsolute(cwd).ResolveFile(fileName)
	if configFileName != "" {
		path = base.ResolveFile(configFileName)
	}
	source := tsoptions.NewTsconfigSourceFileFromFilePath(
		path,
		fs.CaseSensitivity().PathKey(path.AsPath()),
		text,
	)
	parsed := tsoptions.ParseJsonSourceFileConfigFileContent(source, tsoptions.NewDefaultParseConfigHost(fs), base, nil, nil, nil, nil)
	value, err := json.Marshal(config{
		FileNames: parsed.FileNames(),
		Options:   parsed.CompilerOptions(),
		Raw:       parsed.Raw,
		Errors:    convert(parsed.Errors),
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"value": string(value)}, nil
}

func wtf8(value js.Value) string {
	data := make([]byte, value.Length())
	js.CopyBytesToGo(data, value)
	return string(data)
}

func export(fn func(args []js.Value) (map[string]any, error)) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) (result any) {
		defer func() {
			if recovered := recover(); recovered != nil {
				result = map[string]any{"error": fmt.Sprint(recovered)}
			}
		}()
		value, err := fn(args)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return value
	})
}

func main() {
	name := os.Getenv("TSC_COMPAT_GLOBAL")
	if name == "" {
		name = "tscCompat"
	}
	js.Global().Set(name, map[string]any{
		"parse": export(func(args []js.Value) (map[string]any, error) {
			return parse(args[0].String(), wtf8(args[1]), core.ScriptKind(args[2].Int()), args[3].String())
		}),
		"toObject": export(func(args []js.Value) (map[string]any, error) {
			return toObject(args[0].String(), wtf8(args[1]), args[2].String())
		}),
		"parseConfig": export(func(args []js.Value) (map[string]any, error) {
			return parseConfig(args[0].String(), wtf8(args[1]), args[2].String(), args[3].String(), args[4])
		}),
	})
	select {}
}
