import type { ApiErrorShape } from "./types";

export class ApiError extends Error implements ApiErrorShape {
  status: number;
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.name = "ApiError";
    this.status = shape.status;
    this.code = shape.code;
    this.retryable = shape.retryable;
    this.details = shape.details;
  }
}
