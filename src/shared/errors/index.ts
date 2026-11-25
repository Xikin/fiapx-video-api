export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code = 'BAD_REQUEST',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(recurso: string) {
    super(`${recurso} não encontrado`, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(mensagem: string) {
    super(mensagem, 409, 'CONFLICT');
  }
}

export class BusinessError extends AppError {
  constructor(mensagem: string) {
    super(mensagem, 422, 'BUSINESS_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(mensagem = 'Não autenticado') {
    super(mensagem, 401, 'UNAUTHORIZED');
  }
}

export class TooManyRequestsError extends AppError {
  constructor(mensagem: string) {
    super(mensagem, 429, 'RATE_LIMITED');
  }
}
