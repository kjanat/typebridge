import { Effect } from 'effect';
import { decodeMapperMessage, encodeMapperResponse } from '@kjanat/tsc-protocol';
import type {
	MapperConnection,
	MapperRequest,
	MapperResponse,
	MapperResult,
} from '@kjanat/tsc-protocol';
export type { MapperConnection as Connection } from '@kjanat/tsc-protocol';
export type Handler = (request: MapperRequest) => Effect.Effect<MapperResult, Error>;

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

function frame(message: MapperResponse): Uint8Array {
	const body = encoder.encode(encodeMapperResponse(message));
	return concat(encoder.encode(`Content-Length: ${body.length}\r\n\r\n`), body);
}

export function createConnection(
	handle: Handler,
	send: (chunk: Uint8Array) => void,
): MapperConnection {
	let pending = new Uint8Array(0);

	function dispatch(message: MapperRequest | MapperResponse): void {
		if (!('method' in message)) return;
		const { id } = message;
		Effect.runSync(
			handle(message).pipe(
				Effect.match({
					onSuccess: (result) => {
						if (id !== undefined) send(frame({ jsonrpc: '2.0', id, result: result ?? null }));
					},
					onFailure: (error) => {
						if (id === undefined) return;
						send(
							frame({
								jsonrpc: '2.0',
								id,
								error: { code: -32603, message: error.stack ?? error.message },
							}),
						);
					},
				}),
			),
		);
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
				const message = decodeMapperMessage(decoder.decode(pending.subarray(start, stop)));
				pending = pending.slice(stop);
				dispatch(message);
			}
		},
	};
}
