import type { Transporter } from 'nodemailer';
import type { AvisoDeFalha, Notificador } from '../../domain/portas/notificador';

export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export class EmailNotificador implements Notificador {
  constructor(
    private readonly transporte: Pick<Transporter, 'sendMail'>,
    private readonly remetente: string,
  ) {}

  async avisarFalha(aviso: AvisoDeFalha): Promise<void> {
    const nome = escaparHtml(aviso.nomeArquivo);
    await this.transporte.sendMail({
      from: this.remetente,
      to: aviso.destinatario,
      subject: `FIAP X: não conseguimos processar "${aviso.nomeArquivo}"`,
      text: `O processamento do vídeo "${aviso.nomeArquivo}" falhou.\nMotivo: ${aviso.motivo}\nVocê pode enviar o vídeo de novo.\nReferência: ${aviso.videoId}`,
      html: `<p>O processamento do vídeo <strong>${nome}</strong> falhou.</p>
<p>Motivo: ${escaparHtml(aviso.motivo)}</p>
<p>Você pode enviar o vídeo de novo.</p>
<p style="color:#666">Referência: ${escaparHtml(aviso.videoId)}</p>`,
    });
  }
}

/** Sem SMTP configurado, a falha fica só no status e no log. */
export const notificadorDesligado: Notificador = { avisarFalha: async () => {} };
