import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../../shared/errors';
import type { UsuarioAutenticado } from '../../../application/video.dto';

interface Claims {
  sub: string;
  email: string;
  /** Expiração em segundos desde a época (RFC 7519). Obrigatória, ver `requiredClaims`. */
  exp: number;
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
  /**
   * Audiência exigida no claim `aud`. Opcional enquanto o fiapx-auth-lambda não
   * emitir `aud`; quando configurada, token sem `aud` ou com outro valor é recusado.
   */
  audiencia?: string;
  /**
   * Validade máxima aceita (exp - agora), em segundos. Barra tokens "quase eternos"
   * emitidos por engano ou por quem conhece o segredo. Padrão: 24 h.
   */
  validadeMaximaSegundos?: number;
}

export const VALIDADE_MAXIMA_PADRAO_SEGUNDOS = 24 * 60 * 60;

/**
 * `sub` vira parte da chave do S3 (`videos/<sub>/...`) e da chave do cache.
 * Sem `/` nem caracteres de controle, um `sub` não consegue "entrar" na pasta de
 * outro usuário. Cobre UUIDs, hashes hex e ids do Cognito.
 */
const FORMATO_SUB = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * O e-mail é destinatário dos avisos de falha. A checagem é simples de propósito
 * (quem garante o e-mail é a Lambda), mas impede espaços, quebras de linha e
 * caracteres de cabeçalho que poderiam virar injeção no SMTP.
 */
const FORMATO_EMAIL = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/;
const TAMANHO_MAXIMO_EMAIL = 254; // RFC 5321

/**
 * Valida o JWT emitido pelo fiapx-auth-lambda (ADR 0005). O API Gateway também
 * valida na borda; validar de novo aqui mantém a API segura quando chamada por
 * dentro do cluster ou no Docker Compose.
 */
export const autenticacao = fp<OpcoesAutenticacao>(async (app, opcoes) => {
  const validadeMaximaSegundos = opcoes.validadeMaximaSegundos ?? VALIDADE_MAXIMA_PADRAO_SEGUNDOS;

  await app.register(fastifyJwt, {
    secret: opcoes.segredo,
    verify: {
      allowedIss: opcoes.emissor,
      // Só HS256: impede `alg: none` e confusão de algoritmo (HS x RS).
      algorithms: ['HS256'],
      // O fast-jwt só confere `exp` quando o claim existe; sem `requiredClaims`,
      // um token sem `exp` valeria para sempre.
      requiredClaims: ['exp', 'sub', 'iss', ...(opcoes.audiencia ? ['aud'] : [])],
      ...(opcoes.audiencia ? { allowedAud: opcoes.audiencia } : {}),
    },
  });

  app.decorateRequest('usuario', null as unknown as UsuarioAutenticado);
  app.decorate('autenticar', async (req: FastifyRequest) => {
    try {
      const claims = await req.jwtVerify<Claims>();
      validarClaims(claims, validadeMaximaSegundos);
      req.usuario = { id: claims.sub, email: claims.email };
    } catch (erro) {
      // O motivo exato fica só no log (nível debug) para não ensinar o atacante
      // qual verificação falhou; o cliente recebe sempre a mesma resposta.
      req.log.debug(
        { evento: 'token_recusado', motivo: erro instanceof Error ? erro.message : String(erro) },
        'token recusado',
      );
      throw new UnauthorizedError('Token ausente, inválido ou expirado');
    }
  });
});

/** Checagens de conteúdo que a biblioteca não faz. Lança erro em qualquer violação. */
function validarClaims(claims: Claims, validadeMaximaSegundos: number): void {
  // `typeof` antes da regex: o payload é JSON arbitrário e `sub` poderia ser número ou objeto.
  if (typeof claims.sub !== 'string' || !FORMATO_SUB.test(claims.sub))
    throw new Error('sub ausente ou fora do formato');
  if (
    typeof claims.email !== 'string' ||
    claims.email.length > TAMANHO_MAXIMO_EMAIL ||
    !FORMATO_EMAIL.test(claims.email)
  )
    throw new Error('email ausente ou fora do formato');

  // `exp` já foi conferido contra o relógio pelo fast-jwt; aqui o teto superior.
  const agoraSegundos = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp - agoraSegundos > validadeMaximaSegundos)
    throw new Error('validade do token acima do máximo aceito');
}
