export class AppError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'RICHIESTA_NON_VALIDA') {
    super(message);
    this.name = 'AppError';
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Non hai i permessi necessari per questa operazione.') {
    super(message, 403, 'PERMESSO_NEGATO');
    this.name = 'AuthorizationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'La risorsa richiesta non esiste.') {
    super(message, 404, 'NON_TROVATO');
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'La risorsa è stata modificata da un’altra richiesta.') {
    super(message, 409, 'CONFLITTO');
    this.name = 'ConflictError';
  }
}
