import { createHandler } from '#mapper';
import type { Connection } from '#rpc';
import { createConnection } from '#rpc';

export type { Connection } from '#rpc';

export function connect(send: (chunk: Uint8Array) => void): Connection {
	return createConnection(createHandler(), send);
}
