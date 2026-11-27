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

/**
 * Outra operação gravou o mesmo vídeo entre a leitura e a escrita (controle de
 * concorrência otimista). É um 409 no HTTP; no consumidor, o caso de uso relê e
 * tenta de novo.
 */
export class ConcorrenciaError extends ConflictError {
  constructor() {
    super('O vídeo foi alterado por outra operação; tente de novo');
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
