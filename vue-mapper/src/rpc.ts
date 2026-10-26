import { isRecord } from '@kjanat/tsc-protocol';
export type Handler = (method: string, params: unknown) => unknown;

export interface Connection {
	receive(chunk: Uint8Array): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const separator = encoder.encode('\r\n\r\n');

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
	const joined = new Uint8Array(a.length + b.length);
	joined.set(a);
	joined.set(b, a.length);
	return joined;
}

function headerEnd(buffer: Uint8Array): number {
	for (let i = 0; i + separator.length <= buffer.length; i++) {
		if (separator.every((byte, j) => buffer[i + j] === byte)) return i;
	}
	return -1;
}

function frame(message: Readonly<Record<string, unknown>>): Uint8Array {
	const body = encoder.encode(JSON.stringify({ jsonrpc: '2.0', ...message }));
	return concat(encoder.encode(`Content-Length: ${body.length}\r\n\r\n`), body);
}

export function createConnection(handle: Handler, send: (chunk: Uint8Array) => void): Connection {
	let pending = new Uint8Array(0);

	function dispatch(message: unknown): void {
		if (!isRecord(message) || typeof message.method !== 'string') return;
		const { id, method, params } = message;
		try {
			const result = handle(method, params);
			if (id !== undefined) send(frame({ id, result: result ?? null }));
		} catch (error) {
			if (id === undefined) return;
			const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
			send(frame({ id, error: { code: -32603, message: text } }));
		}
	}

	return {
		receive(chunk) {
			pending = concat(pending, chunk);
			for (;;) {
				const end = headerEnd(pending);
				if (end === -1) return;
				const header = decoder.decode(pending.subarray(0, end));
				const length = /^Content-Length: *(\d+)$/im.exec(header)?.[1];
				if (length === undefined) {
					throw new Error(`Missing Content-Length in ${JSON.stringify(header)}`);
				}
				const start = end + separator.length;
				const stop = start + Number(length);
				if (pending.length < stop) return;
				const message: unknown = JSON.parse(decoder.decode(pending.subarray(start, stop)));
				pending = pending.slice(stop);
				dispatch(message);
			}
		},
	};
}
