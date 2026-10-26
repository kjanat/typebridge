import { Schema } from 'effect';

export const MapperTransformParamsSchema = Schema.Struct({
	projectHandle: Schema.String,
	fileName: Schema.String,
	content: Schema.String,
});
export type MapperTransformParams = typeof MapperTransformParamsSchema.Type;

export const MapperDiagnosticSchema = Schema.Struct({
	start: Schema.Int,
	length: Schema.Int,
	code: Schema.Int,
	source: Schema.optional(Schema.String),
});
export type MapperDiagnostic = typeof MapperDiagnosticSchema.Type;

export const MapperVerifyFileSchema = Schema.Struct({
	fileName: Schema.String,
	content: Schema.String,
	virtualText: Schema.String,
	diagnostics: Schema.Array(MapperDiagnosticSchema),
});
export type MapperVerifyFile = typeof MapperVerifyFileSchema.Type;

export const MapperVerifyParamsSchema = Schema.Struct({
	configFileName: Schema.String,
	options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	files: Schema.Array(MapperVerifyFileSchema),
});
export type MapperVerifyParams = typeof MapperVerifyParamsSchema.Type;

const envelope = {
	jsonrpc: Schema.Literal('2.0'),
	id: Schema.optional(Schema.Union([Schema.Int, Schema.String])),
};
export const MapperRequestSchema = Schema.Union([
	Schema.Struct({
		...envelope,
		method: Schema.Literal('initialize'),
		params: Schema.optional(Schema.Unknown),
	}),
	Schema.Struct({
		...envelope,
		method: Schema.Literal('openProject'),
		params: Schema.Struct({ projectHandle: Schema.String, configFileName: Schema.String }),
	}),
	Schema.Struct({
		...envelope,
		method: Schema.Literal('closeProject'),
		params: Schema.Struct({ projectHandle: Schema.String }),
	}),
	Schema.Struct({
		...envelope,
		method: Schema.Literal('transform'),
		params: MapperTransformParamsSchema,
	}),
	Schema.Struct({
		...envelope,
		method: Schema.Literal('verify'),
		params: MapperVerifyParamsSchema,
	}),
]);
export type MapperRequest = typeof MapperRequestSchema.Type;

export const MapperSourceSpanSchema = Schema.Struct({ start: Schema.Int, length: Schema.Int });
export type MapperSourceSpan = typeof MapperSourceSpanSchema.Type;

export const MapperSegmentSchema = Schema.Tuple([
	Schema.Int,
	Schema.Int,
	Schema.Int,
	Schema.Int,
	Schema.Int,
]);
export type MapperSegment = typeof MapperSegmentSchema.Type;

export const MapperResultSchema = Schema.Union([
	Schema.Struct({ positionEncoding: Schema.Literal('utf-16'), diagnosticSource: Schema.String }),
	Schema.Struct({
		text: Schema.String,
		extension: Schema.String,
		mappings: Schema.Array(MapperSegmentSchema),
		diagnosticDirectives: Schema.Struct({
			unusedExpectDirectiveDiagnostics: Schema.Array(Schema.Never),
			directives: Schema.Array(MapperSegmentSchema),
		}),
	}),
	Schema.Array(Schema.Array(Schema.NullOr(MapperSourceSpanSchema))),
	Schema.Record(Schema.String, Schema.Never),
	Schema.Null,
]);
export type MapperResult = typeof MapperResultSchema.Type;

const response = { jsonrpc: Schema.Literal('2.0'), id: Schema.Union([Schema.Int, Schema.String]) };
export const MapperResponseSchema = Schema.Union([
	Schema.Struct({ ...response, result: MapperResultSchema }),
	Schema.Struct({
		...response,
		error: Schema.Struct({ code: Schema.Int, message: Schema.String }),
	}),
]);
export type MapperResponse = typeof MapperResponseSchema.Type;

export const decodeMapperMessage = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Union([MapperRequestSchema, MapperResponseSchema])),
);

export interface MapperConnection {
	receive(chunk: Uint8Array): void;
}

export interface MapperModule {
	connect(send: (chunk: Uint8Array) => void): MapperConnection;
}

export const encodeMapperResponse = Schema.encodeSync(Schema.fromJsonString(MapperResponseSchema));
