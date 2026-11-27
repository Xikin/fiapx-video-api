import { Prisma, type PrismaClient, type Video as LinhaVideo } from '@prisma/client';
import { Video } from '../../domain/videos/video';
import type { MensagemConsumida, VideoRepository } from '../../domain/portas/video.repository';
import type { Mensagem } from '../../domain/mensageria/contratos';

type Tx = Prisma.TransactionClient;

function paraEntidade(linha: LinhaVideo): Video {
  return Video.restaurar({ ...linha, tamanhoBytes: Number(linha.tamanhoBytes) });
}

function paraLinha(video: Video) {
  const { id, ...resto } = video.paraDados();
  return { id, dados: { ...resto, tamanhoBytes: BigInt(resto.tamanhoBytes) } };
}

const ehDuplicada = (erro: unknown) =>
  erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002';

export class PrismaVideoRepository implements VideoRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async criar(video: Video): Promise<void> {
    const { id, dados } = paraLinha(video);
    await this.prisma.video.create({ data: { id, ...dados } });
  }

  async buscarPorId(id: string): Promise<Video | null> {
    const linha = await this.prisma.video.findUnique({ where: { id } });
    return linha ? paraEntidade(linha) : null;
  }

  async listarPorUsuario(usuarioId: string): Promise<Video[]> {
    const linhas = await this.prisma.video.findMany({
      where: { usuarioId },
      orderBy: { criadoEm: 'desc' },
      take: 200,
    });
    return linhas.map(paraEntidade);
  }

  async contarAguardandoEnvioDesde(usuarioId: string, desde: Date): Promise<number> {
    // Usa o índice (usuario_id, criado_em): o filtro por status só olha as linhas
    // recentes do próprio usuário, então a contagem continua barata.
    return this.prisma.video.count({
      where: { usuarioId, status: 'AGUARDANDO_ENVIO', criadoEm: { gte: desde } },
    });
  }

  async salvar(video: Video, saida: Mensagem[] = []): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.atualizar(tx, video);
      if (saida.length)
        await tx.outbox.createMany({
          data: saida.map((m) => ({
            id: m.id,
            routingKey: m.tipo,
            payload: m as unknown as Prisma.InputJsonValue,
          })),
        });
    });
  }

  async jaConsumida(mensagem: MensagemConsumida): Promise<boolean> {
    const linha = await this.prisma.mensagemProcessada.findUnique({
      where: { id_consumidor: mensagem },
    });
    return linha !== null;
  }

  async salvarAoConsumir(video: Video, mensagem: MensagemConsumida): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.mensagemProcessada.create({ data: mensagem });
        await this.atualizar(tx, video);
      });
      return true;
    } catch (erro) {
      if (ehDuplicada(erro)) return false;
      throw erro;
    }
  }

  private async atualizar(tx: Tx, video: Video): Promise<void> {
    const { id, dados } = paraLinha(video);
    await tx.video.update({ where: { id }, data: dados });
  }
}
