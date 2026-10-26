import fs from 'node:fs';
import { EOL } from 'node:os';

export interface FileSystemEntries {
	readonly files: readonly string[];
	readonly directories: readonly string[];
}

export interface ParseConfigHost {
	readonly useCaseSensitiveFileNames: boolean;
	fileExists(path: string): boolean;
	readFile(path: string): string | undefined;
	directoryExists?(path: string): boolean;
	realpath?(path: string): string;
	getAccessibleFileSystemEntries?(path: string): FileSystemEntries;
	getCurrentDirectory?(): string;
}

export interface System extends ParseConfigHost {
	readonly newLine: string;
	directoryExists(path: string): boolean;
	realpath(path: string): string;
	getDirectories(path: string): string[];
	getAccessibleFileSystemEntries(path: string): FileSystemEntries;
	getCurrentDirectory(): string;
}

function stat(path: string): fs.Stats | undefined {
	try {
		return fs.statSync(path, { throwIfNoEntry: false });
	} catch {
		return undefined;
	}
}

function swapCase(text: string): string {
	return text.replace(/\w/g, (character) => {
		const upper = character.toUpperCase();
		return character === upper ? character.toLowerCase() : upper;
	});
}

function readFile(path: string): string | undefined {
	let buffer: Buffer;
	try {
		buffer = fs.readFileSync(path);
	} catch {
		return undefined;
	}
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		const swapped = Buffer.from(buffer.subarray(2));
		swapped.swap16();
		return swapped.toString('utf16le');
	}
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return buffer.toString('utf16le', 2);
	}
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return buffer.toString('utf8', 3);
	}
	return buffer.toString('utf8');
}

function getAccessibleFileSystemEntries(path: string): FileSystemEntries {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path || '.', { withFileTypes: true });
	} catch {
		return { files: [], directories: [] };
	}
	const files: string[] = [];
	const directories: string[] = [];
	for (const entry of entries) {
		const kind = entry.isSymbolicLink() ? stat(`${path}/${entry.name}`) : entry;
		if (kind === undefined) continue;
		if (kind.isFile()) files.push(entry.name);
		else if (kind.isDirectory()) directories.push(entry.name);
	}
	files.sort();
	directories.sort();
	return { files, directories };
}

export const sys: System = {
	newLine: EOL,
	useCaseSensitiveFileNames:
		process.platform !== 'win32' && !fs.existsSync(swapCase(import.meta.filename)),
	readFile,
	fileExists: (path) => stat(path)?.isFile() ?? false,
	directoryExists: (path) => stat(path)?.isDirectory() ?? false,
	realpath(path) {
		try {
			return fs.realpathSync.native(path);
		} catch {
			return path;
		}
	},
	getDirectories: (path) => [...getAccessibleFileSystemEntries(path).directories],
	getAccessibleFileSystemEntries,
	getCurrentDirectory: () => process.cwd(),
};
