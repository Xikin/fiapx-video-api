import { Video } from '../../domain/videos/video';
import type { VideoRepository } from '../../domain/portas/video.repository';
import type { Armazenamento, UrlAssinada } from '../../domain/portas/armazenamento';
import { chaveListaDoUsuario, type Cache } from '../../domain/portas/cache';
import type { GeradorDeId, Relogio } from '../../domain/portas/relogio';
import { BusinessError, TooManyRequestsError } from '../../shared/errors';
import { paraDto, type UsuarioAutenticado, type VideoDto } from '../video.dto';

export const TIPOS_DE_VIDEO_ACEITOS = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
] as const;

export interface SolicitarEnvioEntrada {
  usuario: UsuarioAutenticado;
  nomeArquivo: string;
  contentType: string;
  tamanhoBytes: number;
}

export interface SolicitarEnvioSaida {
  video: VideoDto;
  envio: UrlAssinada;
}

/**
 * Limite de envios abertos por usuário. Só conta vídeos em AGUARDANDO_ENVIO
 * criados dentro da `janelaSegundos` (o TTL da URL assinada): depois disso a URL
 * expirou e o envio abandonado não pode mais ser concluído, então não deve
 * bloquear o usuário para sempre.
 */
export interface LimiteDeEnviosPendentes {
  maximo: number;
  janelaSegundos: number;
}

/**
 * Regras de envio que vêm da configuração. Agrupadas num objeto com nomes para
 * não depender da ordem de vários números no construtor (fácil de trocar sem o
 * compilador perceber).
 */
export interface PoliticaDeEnvio {
  tamanhoMaximoBytes: number;
  /** Cota de envios em aberto por usuário. Ausente = sem cota. */
  pendentes?: LimiteDeEnviosPendentes;
}

/**
 * Primeiro passo do envio: registra o vídeo e devolve uma URL assinada para o
 * cliente mandar o arquivo direto ao S3 (ADR 0002). Nada vai para a fila ainda.
 */
export class SolicitarEnvioUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly armazenamento: Armazenamento,
    private readonly cache: Cache,
    private readonly ids: GeradorDeId,
    private readonly relogio: Relogio,
    private readonly politica: PoliticaDeEnvio,
  ) {}

  async execute(entrada: SolicitarEnvioEntrada): Promise<SolicitarEnvioSaida> {
    const { tamanhoMaximoBytes } = this.politica;
    if (!(TIPOS_DE_VIDEO_ACEITOS as readonly string[]).includes(entrada.contentType))
      throw new BusinessError(
        `Tipo de arquivo não aceito: ${entrada.contentType}. Envie ${TIPOS_DE_VIDEO_ACEITOS.join(', ')}`,
      );
    if (entrada.tamanhoBytes > tamanhoMaximoBytes)
      throw new BusinessError(
        `O vídeo passa do limite de ${Math.floor(tamanhoMaximoBytes / 1024 / 1024)} MB`,
      );

    const agora = this.relogio.agora();
    await this.verificarCota(entrada.usuario.id, agora);

    const video = Video.criar({
      id: this.ids.novo(),
      usuarioId: entrada.usuario.id,
      emailUsuario: entrada.usuario.email,
      nomeArquivo: entrada.nomeArquivo,
      contentType: entrada.contentType,
      tamanhoBytes: entrada.tamanhoBytes,
      agora,
    });

    await this.videos.criar(video);
    await this.cache.remover(chaveListaDoUsuario(entrada.usuario.id));
    const envio = await this.armazenamento.urlDeEnvio(
      video.chaveVideo,
      entrada.contentType,
      entrada.tamanhoBytes,
    );
    return { video: paraDto(video), envio };
  }

  /**
   * Recusa com 429 quando o usuário já tem o máximo de envios abertos.
   *
   * Corrida aceita: duas requisições simultâneas podem ler a mesma contagem e
   * passar juntas, estourando o limite por poucas unidades. Para uma cota de
   * custo isso basta; o rate limit global segura rajadas maiores.
   */
  private async verificarCota(usuarioId: string, agora: Date): Promise<void> {
    const cota = this.politica.pendentes;
    if (!cota) return; // cota desligada: nem consulta o banco
    const { maximo, janelaSegundos } = cota;

    const desde = new Date(agora.getTime() - janelaSegundos * 1000);
    const abertos = await this.videos.contarAguardandoEnvioDesde(usuarioId, desde);
    if (abertos >= maximo)
      throw new TooManyRequestsError(
        `Você já tem ${abertos} envios em aberto; conclua-os ou aguarde ${Math.ceil(janelaSegundos / 60)} min`,
      );
  }
}
