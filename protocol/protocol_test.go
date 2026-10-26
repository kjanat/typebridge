package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

func TestConcurrentProjectRequests(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"tsconfig.json": `{"compilerOptions":{"strict":true,"target":"ESNext","module":"NodeNext","types":[]},"include":["*.ts"]}`,
		"codes.ts":      "export type AErrorCode = 'a' | 'b';\n",
		"index.ts":      "export type { AErrorCode } from './codes.js';\n",
		"loose.ts":      "export function g(x) { return x; }\n",
	}
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	config := filepath.Join(dir, "tsconfig.json")
	requests := []Request{
		{Method: "checkProject", ConfigPath: config},
		{Method: "exportedCodeUnions", ConfigPath: config, Entrypoints: []string{"index.ts"}},
		{Method: "checkProject", ConfigPath: config, CompilerOptions: json.RawMessage(`{"strict":false}`)},
		{Method: "checkProject", ConfigPath: config, Files: []string{"loose.ts"}},
	}
	want := make([]Response, len(requests))
	for i, req := range requests {
		want[i] = Handle(req)
	}
	got := make([]Response, len(requests)*8)
	var wg sync.WaitGroup
	for i := range got {
		wg.Go(func() { got[i] = Handle(requests[i%len(requests)]) })
	}
	wg.Wait()
	for i, res := range got {
		if expected := want[i%len(requests)]; !reflect.DeepEqual(res, expected) {
			t.Errorf("Request %d: got %+v, want %+v", i, res, expected)
		}
	}
	if len(want[0].Diagnostics) == 0 || len(want[1].Unions) == 0 {
		t.Fatalf("probe project must produce diagnostics and unions: %+v", want[:2])
	}
}
