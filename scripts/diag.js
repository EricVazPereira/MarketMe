// Diagnóstico de conexão do MarketMe (rode no PC do servidor):
//   npm run diag
// Verifica cada elo da corrente e imprime o que configurar no tablet.
import os from 'node:os';
import net from 'node:net';
import { execSync } from 'node:child_process';
import { config } from '../src/config.js';

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);
const info = (m) => console.log(`  • ${m}`);

function lanIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

const tcpOpen = (host, port, timeout = 1500) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port, timeout });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });

async function main() {
  console.log('\n════════ MarketMe — diagnóstico de conexão ════════\n');

  // 1. IPs da máquina
  console.log('1) Endereços de rede deste PC:');
  const ips = lanIPs();
  if (ips.length === 0) bad('nenhuma rede encontrada — o PC está conectado?');
  for (const ip of ips) info(`${ip.address}  (${ip.name})`);
  const mainIp = ips[0]?.address ?? 'IP-DO-PC';

  // 2. Conector (este servidor) rodando?
  console.log(`\n2) Conector MarketMe (porta ${config.port}):`);
  let conectorOk = false;
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/health`);
    conectorOk = r.ok;
  } catch { /* não está de pé */ }
  if (conectorOk) ok(`respondendo em http://127.0.0.1:${config.port}`);
  else bad(`nada respondendo na porta ${config.port} — abra outro terminal e rode: npm start`);

  // 3. Firebird
  console.log('\n3) Firebird do ERP:');
  info(`host ${config.firebird.host}, porta ${config.firebird.port}`);
  info(`banco: ${config.firebird.database}`);
  const fbPort = await tcpOpen(config.firebird.host, config.firebird.port);
  if (!fbPort) {
    bad(`porta ${config.firebird.port} fechada — o serviço do Firebird está rodando? (services.msc)`);
  } else {
    ok(`porta ${config.firebird.port} aberta`);
    try {
      const { fbQuery } = await import('../src/firebird.js');
      await fbQuery('SELECT FIRST 1 1 AS X FROM RDB$DATABASE');
      ok(`conectou no banco como ${config.firebird.user}`);
    } catch (e) {
      bad(`não conectou no banco: ${e.message}`);
      info('se for Firebird 3.0+, veja no README a seção sobre WireCrypt/Legacy_Auth');
    }
  }

  // 4. PostgreSQL local
  console.log('\n4) PostgreSQL local (pedidos):');
  try {
    const { pool } = await import('../src/db.js');
    await pool.query('SELECT 1');
    await pool.end();
    ok('conectado');
  } catch (e) {
    bad(`sem conexão: ${e.message} — rode: npm run db:setup`);
  }

  // 5. Firewall (Windows)
  console.log('\n5) Firewall:');
  if (process.platform === 'win32') {
    try {
      const rules = execSync(
        'netsh advfirewall firewall show rule name="MarketMe" 2>NUL',
        { encoding: 'utf8' },
      );
      if (/MarketMe/i.test(rules)) ok('regra "MarketMe" existe no Firewall do Windows');
      else throw new Error('sem regra');
    } catch {
      bad(`sem regra liberando a porta ${config.port} — o tablet pode ser bloqueado.`);
      info('Para liberar, rode no PowerShell COMO ADMINISTRADOR:');
      info(`netsh advfirewall firewall add rule name="MarketMe" dir=in action=allow protocol=TCP localport=${config.port}`);
    }
  } else {
    info('fora do Windows: confira o firewall do sistema manualmente');
  }

  // 6. Resumo para o tablet
  console.log('\n════════ CONFIGURE ASSIM NO TABLET ════════\n');
  console.log(`  Diretório do banco de dados:  ${config.firebird.database}`);
  console.log(`  Endereço do conector no PC:   http://${mainIp}:${config.port}`);
  console.log('\n  (tablet e PC precisam estar na MESMA rede Wi-Fi)');
  if (ips.length > 1)
    console.log(
      `  Se não conectar com esse IP, tente os outros listados no item 1.`,
    );
  console.log(
    '\n  Teste rápido: abra o navegador DO TABLET e acesse\n' +
    `  http://${mainIp}:${config.port}/health — deve mostrar {"ok":true}\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error('Erro no diagnóstico:', e.message ?? e);
  process.exit(1);
});
