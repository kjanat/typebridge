import { renameSync, writeFileSync } from 'node:fs';

process.stdin.once('data', () => {
	const temporary = new URL('./ready.tmp', import.meta.url);
	writeFileSync(temporary, String(process.pid));
	renameSync(temporary, new URL('./ready', import.meta.url));
});
process.stdin.resume();
