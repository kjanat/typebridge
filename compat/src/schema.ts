import { Schema } from 'effect';

export const DiagnosticSchema = Schema.Struct({
	fileName: Schema.optional(Schema.String),
	start: Schema.optional(Schema.Int),
	length: Schema.optional(Schema.Int),
	code: Schema.Int,
	category: Schema.Int,
	messageText: Schema.String,
});
export type Diagnostic = typeof DiagnosticSchema.Type;

export const ParsedCommandLineSchema = Schema.Struct({
	options: Schema.Record(Schema.String, Schema.Unknown),
	fileNames: Schema.Array(Schema.String),
	raw: Schema.optional(Schema.Unknown),
	errors: Schema.Array(DiagnosticSchema),
});
export type ParsedCommandLine = typeof ParsedCommandLineSchema.Type;

export const decodeDiagnostics = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Array(DiagnosticSchema)),
);
export const decodeParsedCommandLine = Schema.decodeUnknownSync(
	Schema.fromJsonString(ParsedCommandLineSchema),
);
