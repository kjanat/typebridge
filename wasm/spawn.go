//go:build js && wasm

package main

import (
	"errors"
	"fmt"
	"io"
	"sync"
	"syscall/js"
)

type hostProcess struct {
	handle   js.Value
	mu       sync.Mutex
	arrived  *sync.Cond
	buffered []byte
	done     error
	closed   bool
}

func (p *hostProcess) Read(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for len(p.buffered) == 0 && p.done == nil {
		p.arrived.Wait()
	}
	if len(p.buffered) == 0 {
		return 0, p.done
	}
	n := copy(b, p.buffered)
	p.buffered = p.buffered[n:]
	return n, nil
}

func (p *hostProcess) Write(b []byte) (int, error) {
	p.mu.Lock()
	stopped := p.closed || p.done != nil
	p.mu.Unlock()
	if stopped {
		return 0, io.ErrClosedPipe
	}
	chunk := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(chunk, b)
	p.handle.Call("write", chunk)
	return len(b), nil
}

func (p *hostProcess) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	p.mu.Unlock()
	p.handle.Call("close")
	return nil
}

func bytesOf(value js.Value) []byte {
	b := make([]byte, value.Get("length").Int())
	js.CopyBytesToGo(b, value)
	return b
}

func hostSpawner(spawn js.Value) func([]string, string, io.Writer) (io.ReadWriteCloser, error) {
	return func(command []string, dir string, stderr io.Writer) (io.ReadWriteCloser, error) {
		p := &hostProcess{}
		p.arrived = sync.NewCond(&p.mu)
		var callbacks []js.Func
		onStdout := js.FuncOf(func(this js.Value, args []js.Value) any {
			chunk := bytesOf(args[0])
			p.mu.Lock()
			p.buffered = append(p.buffered, chunk...)
			p.mu.Unlock()
			p.arrived.Broadcast()
			return nil
		})
		onStderr := js.FuncOf(func(this js.Value, args []js.Value) any {
			_, _ = stderr.Write(bytesOf(args[0]))
			return nil
		})
		onClose := js.FuncOf(func(this js.Value, args []js.Value) any {
			done := error(io.EOF)
			if message := args[1]; message.Type() == js.TypeString {
				done = errors.New(message.String())
			} else if code := args[0]; code.Type() == js.TypeNumber && code.Int() != 0 {
				done = fmt.Errorf("process exited with code %d", code.Int())
			}
			p.mu.Lock()
			p.done = done
			p.mu.Unlock()
			p.arrived.Broadcast()
			go func() {
				for _, callback := range callbacks {
					callback.Release()
				}
			}()
			return nil
		})
		callbacks = []js.Func{onStdout, onStderr, onClose}
		args := make([]any, len(command))
		for i, part := range command {
			args[i] = part
		}
		p.handle = spawn.Invoke(js.ValueOf(args), dir, onStdout, onStderr, onClose)
		return p, nil
	}
}
