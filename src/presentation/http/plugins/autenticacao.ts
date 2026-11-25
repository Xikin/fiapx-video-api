import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../../shared/errors';
import type { UsuarioAutenticado } from '../../../application/video.dto';

interface Claims {
  sub: string;
  email: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: Claims;
    user: Claims;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    autenticar(req: FastifyRequest, rep: FastifyReply): Promise<void>;
  }
  interface FastifyRequest {
    usuario: UsuarioAutenticado;
  }
}

export interface OpcoesAutenticacao {
  segredo: string;
  emissor: string;
}

/**
 * Valida o JWT emitido pelo fiapx-auth-lambda (ADR 0005). O API Gateway também
 * valida na borda; validar de novo aqui mantém a API segura quando chamada por
 * dentro do cluster ou no Docker Compose.
 */
export const autenticacao = fp<OpcoesAutenticacao>(async (app, opcoes) => {
  await app.register(fastifyJwt, {
    secret: opcoes.segredo,
    verify: { allowedIss: opcoes.emissor, algorithms: ['HS256'] },
  });

  app.decorateRequest('usuario', null as unknown as UsuarioAutenticado);
  app.decorate('autenticar', async (req: FastifyRequest) => {
    try {
      const claims = await req.jwtVerify<Claims>();
      if (!claims.sub || !claims.email) throw new Error('token sem sub ou email');
      req.usuario = { id: claims.sub, email: claims.email };
    } catch {
      throw new UnauthorizedError('Token ausente, inválido ou expirado');
    }
  });
});
