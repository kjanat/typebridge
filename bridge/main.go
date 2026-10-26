// A small JSON-lines bridge to the TypeScript Go compiler.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/microsoft/TypeScript/tsc/protocol"
)

func run(in io.Reader, out io.Writer) error {
	decoder, encoder := json.NewDecoder(in), json.NewEncoder(out)
	for {
		var req protocol.Request
		if err := decoder.Decode(&req); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("decode request: %w", err)
		}
		if err := encoder.Encode(protocol.Handle(req)); err != nil {
			return err
		}
	}
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
