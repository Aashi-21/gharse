import net from 'node:net';

export interface SinkMessage {
  from: string;
  to: string[];
  data: string;
}

/**
 * A minimal SMTP server that accepts mail and keeps it in memory. Local testing only: lets the REAL mailer (nodemailer)
 * run a full SMTP conversation without any external service, account or credentials.
 */
export async function startSmtpSink(opts: { port?: number; onMessage?: (m: SinkMessage) => void } = {}) {
  const messages: SinkMessage[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = '';
    let inData = false;
    let cur: SinkMessage = { from: '', to: [], data: '' };
    const reply = (s: string) => sock.write(s + '\r\n');
    reply('220 smtp-sink ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          messages.push(cur);
          opts.onMessage?.(cur);
          cur = { from: '', to: [], data: '' };
          reply('250 OK queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) sock.write('250-smtp-sink\r\n250 8BITMIME\r\n');
        else if (cmd.startsWith('MAIL FROM')) { cur.from = line.slice(10).trim(); reply('250 OK'); }
        else if (cmd.startsWith('RCPT TO')) { cur.to.push(line.slice(8).trim()); reply('250 OK'); }
        else if (cmd === 'DATA') { inData = true; reply('354 End data with <CR><LF>.<CR><LF>'); }
        else if (cmd === 'QUIT') { reply('221 bye'); sock.end(); }
        else if (cmd === 'RSET' || cmd === 'NOOP') reply('250 OK');
        else reply('502 command not supported');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    messages,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
