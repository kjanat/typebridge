//go:build js && wasm

package main

import (
	"encoding/json"
	"os"
	"syscall/js"

	"github.com/microsoft/TypeScript/tsc/protocol"
)

func main() {
	name := os.Getenv("TSC_WASM_GLOBAL")
	if name == "" {
		name = "tscWasm"
	}
	done := make(chan struct{})
	invoke := js.FuncOf(func(this js.Value, args []js.Value) any {
		input := args[0].String()
		executor := js.FuncOf(func(this js.Value, callbacks []js.Value) any {
			resolve, reject := callbacks[0], callbacks[1]
			go func() {
				var req protocol.Request
				if err := json.Unmarshal([]byte(input), &req); err != nil {
					reject.Invoke(err.Error())
					return
				}
				output, err := json.Marshal(protocol.Handle(req))
				if err != nil {
					reject.Invoke(err.Error())
					return
				}
				resolve.Invoke(string(output))
			}()
			return nil
		})
		promise := js.Global().Get("Promise").New(executor)
		executor.Release()
		return promise
	})
	stop := js.FuncOf(func(this js.Value, args []js.Value) any {
		close(done)
		return nil
	})
	api := js.Global().Get(name)
	if api.Type() != js.TypeObject {
		api = js.Global().Get("Object").New()
	}
	if spawn := api.Get("spawn"); spawn.Type() == js.TypeFunction {
		protocol.SetSpawner(hostSpawner(spawn))
	}
	api.Set("invoke", invoke)
	api.Set("close", stop)
	js.Global().Set(name, api)
	<-done
	js.Global().Delete(name)
	invoke.Release()
	stop.Release()
}
