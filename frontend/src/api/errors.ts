import type { ApiErrorShape } from "./types";

export class ApiError extends Error implements ApiErrorShape {
  status: number;
  code: string;
  retryable: boolean;

  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.name = "ApiError";
    this.status = shape.status;
    this.code = shape.code;
    this.retryable = shape.retryable;
  }
}
