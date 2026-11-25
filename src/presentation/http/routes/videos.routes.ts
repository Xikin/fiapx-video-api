import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { CasosDeUso } from '../../../app';
import { TIPOS_DE_VIDEO_ACEITOS } from '../../../application/use-cases/solicitar-envio.use-case';
import { STATUS_VIDEO } from '../../../domain/videos/video';

const videoSchema = z.object({
  id: z.string().uuid(),
  nomeArquivo: z.string(),
  status: z.enum(STATUS_VIDEO),
  tamanhoBytes: z.number(),
  totalFrames: z.number().nullable(),
  motivoFalha: z.string().nullable(),
  downloadDisponivel: z.boolean(),
  criadoEm: z.string(),
  atualizadoEm: z.string(),
});

const urlAssinadaSchema = z.object({
  url: z.string().url(),
  metodo: z.enum(['PUT', 'GET']),
  cabecalhos: z.record(z.string(), z.string()),
  expiraEm: z.date(),
});

const erroSchema = z.object({
  statusCode: z.number(),
  code: z.string(),
  message: z.string(),
  errors: z.array(z.object({ campo: z.string(), mensagem: z.string().optional() })).optional(),
});
const idParams = z.object({ id: z.string().uuid() });
const seguranca = [{ bearerAuth: [] }];

export const videosRoutes: FastifyPluginAsyncZod<{ casos: CasosDeUso }> = async (
  app,
  { casos },
) => {
  app.addHook('onRequest', app.autenticar);

  app.post(
    '/',
    {
      schema: {
        tags: ['Vídeos'],
        summary: 'Registra um vídeo e devolve a URL assinada para enviá-lo ao S3',
        description:
          'Envie o arquivo com `PUT` na `envio.url`, usando os `envio.cabecalhos`, e depois chame `POST /videos/{id}/confirmar-envio`.',
        security: seguranca,
        body: z.object({
          nomeArquivo: z.string().trim().min(1).max(255),
          contentType: z.enum(TIPOS_DE_VIDEO_ACEITOS),
          tamanhoBytes: z.number().int().positive(),
        }),
        response: {
          201: z.object({ video: videoSchema, envio: urlAssinadaSchema }),
          401: erroSchema,
          422: erroSchema,
        },
      },
    },
    async (req, rep) =>
      rep
        .status(201)
        .send(await casos.solicitarEnvio.execute({ usuario: req.usuario, ...req.body })),
  );

  app.post(
    '/:id/confirmar-envio',
    {
      schema: {
        tags: ['Vídeos'],
        summary: 'Confirma que o arquivo chegou ao S3 e coloca o vídeo na fila',
        security: seguranca,
        params: idParams,
        response: { 202: videoSchema, 404: erroSchema, 409: erroSchema, 422: erroSchema },
      },
    },
    async (req, rep) =>
      rep.status(202).send(await casos.confirmarEnvio.execute(req.usuario.id, req.params.id)),
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['Vídeos'],
        summary: 'Lista os vídeos do usuário com o status de cada um',
        security: seguranca,
        response: { 200: z.object({ videos: z.array(videoSchema) }) },
      },
    },
    async (req) => ({ videos: await casos.listarVideos.execute(req.usuario.id) }),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Vídeos'],
        summary: 'Detalhe e status de um vídeo',
        security: seguranca,
        params: idParams,
        response: { 200: videoSchema, 404: erroSchema },
      },
    },
    async (req) => casos.obterVideo.execute(req.usuario.id, req.params.id),
  );

  app.get(
    '/:id/download',
    {
      schema: {
        tags: ['Vídeos'],
        summary: 'URL assinada para baixar o zip com os frames',
        security: seguranca,
        params: idParams,
        response: { 200: urlAssinadaSchema, 404: erroSchema, 409: erroSchema },
      },
    },
    async (req) => casos.gerarDownload.execute(req.usuario.id, req.params.id),
  );
};
