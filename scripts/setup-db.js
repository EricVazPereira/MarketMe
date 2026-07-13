// Configuração automática do banco do MarketMe (Windows/Linux/macOS).
// Uso: npm run db:setup
//
// O que faz, nesta ordem:
//   1. Procura instâncias do PostgreSQL nas portas comuns (5432-5435).
//   2. Pede a senha do superusuário "postgres" da instância escolhida.
//   3. Cria (ou reaproveita) um usuário exclusivo do MarketMe com senha
//      gerada aleatoriamente — nunca reutiliza credenciais de outros
//      sistemas/bancos que você tenha na mesma máquina.
//   4. Grava o DATABASE_URL no .env e cria as tabelas (e os dados de
//      exemplo, apenas se o banco estiver vazio).
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const APP_USER = 'marketme_app';
const APP_DB = 'marketme';
const PORTS = [5432, 5433, 5434, 5435];

const root = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const genPassword = () => randomBytes(18).toString('base64url');

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 400 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });

async function tryConnect({ user, password, port, database }) {
  const client = new pg.Client({
    host: '127.0.0.1', port, user, password, database,
    connectionTimeoutMillis: 4000,
  });
  try {
    await client.connect();
    return client; // chamador fecha
  } catch (err) {
    await client.end().catch(() => {});
    return err.code ?? String(err);
  }
}

async function ensureSchemaAndSeed(port, user, pass) {
  const client = await tryConnect({ user, password: pass, port, database: APP_DB });
  if (typeof client === 'string') throw new Error(`falha ao abrir ${APP_DB}: ${client}`);
  await client.query(await readFile(root('db/schema.sql'), 'utf8'));
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM store');
  if (rows[0].n === 0) {
    await client.query(await readFile(root('db/seed.sql'), 'utf8'));
    console.log('✔ Tabelas criadas e dados de exemplo inseridos.');
  } else {
    console.log('✔ Tabelas OK (banco já tinha dados; seed não repetido).');
  }
  await client.end();
}

async function writeEnv(url) {
  let env;
  try {
    await access(root('.env'));
    env = await readFile(root('.env'), 'utf8');
  } catch {
    env = await readFile(root('.env.example'), 'utf8');
  }
  const line = `DATABASE_URL=${url}`;
  env = /^DATABASE_URL=.*$/m.test(env)
    ? env.replace(/^DATABASE_URL=.*$/m, line)
    : `${line}\n${env}`;
  await writeFile(root('.env'), env);
  console.log('✔ .env atualizado com a nova DATABASE_URL.');
}

async function main() {
  console.log('Procurando PostgreSQL nas portas comuns...');
  const open = [];
  for (const p of PORTS) if (await portOpen(p)) open.push(p);
  if (open.length === 0) {
    console.error(
      'Nenhum PostgreSQL encontrado (portas 5432-5435).\n' +
      'Verifique se o serviço está rodando: services.msc → postgresql...',
    );
    process.exit(1);
  }

  let port = open[0];
  if (open.length > 1) {
    console.log(`Mais de uma instância de PostgreSQL encontrada: ${open.join(', ')}.`);
    const ans = await rl.question(
      `Em qual porta instalar o MarketMe? [${open.join('/')}] (Enter = ${open[0]}): `,
    );
    const n = Number(ans.trim());
    if (open.includes(n)) port = n;
  } else {
    console.log(`PostgreSQL encontrado na porta ${port}.`);
  }

  console.log(
    '\nO MarketMe usa um usuário e banco PRÓPRIOS, exclusivos deste ' +
    'projeto — não reaproveita credenciais de outros bancos/sistemas ' +
    'que você tenha na mesma máquina (Firebird, outros projetos, etc.).',
  );
  const MAX_TRIES = 4;
  let su;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const superPass = await rl.question(
      attempt === 1
        ? `\nSenha do superusuário "postgres" na porta ${port} (a definida na ` +
          'instalação do PostgreSQL, necessária só para criar o usuário/banco ' +
          'do MarketMe uma única vez): '
        : `Senha incorreta. Tente de novo (${attempt}/${MAX_TRIES}): `,
    );
    const result = await tryConnect({
      user: 'postgres', password: superPass.trim(), port, database: 'postgres',
    });
    if (typeof result !== 'string') { su = result; break; }
    if (result !== '28P01') {
      // erro diferente de "senha incorreta" (ex.: postgres fora do ar) —
      // tentar de novo não vai ajudar
      console.error(`Não conectou como postgres (${result}).`);
      process.exit(1);
    }
    if (attempt === MAX_TRIES) {
      console.error(
        '\nSenha incorreta em todas as tentativas.\n' +
        'Se você não lembra a senha do usuário "postgres", é preciso ' +
        'redefini-la (veja o README, seção "Esqueci a senha do postgres") ' +
        'e rodar "npm run db:setup" de novo.',
      );
      process.exit(1);
    }
  }

  const appPass = genPassword();
  const role = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_USER]);
  if (role.rowCount === 0) {
    await su.query(`CREATE ROLE ${APP_USER} LOGIN PASSWORD '${appPass}' CREATEDB`);
    console.log(`✔ Usuário ${APP_USER} criado (senha gerada automaticamente).`);
  } else {
    await su.query(`ALTER ROLE ${APP_USER} WITH LOGIN PASSWORD '${appPass}'`);
    console.log(`✔ Usuário ${APP_USER} já existia; senha renovada.`);
  }

  const db = await su.query('SELECT 1 FROM pg_database WHERE datname = $1', [APP_DB]);
  if (db.rowCount === 0) {
    await su.query(`CREATE DATABASE ${APP_DB} OWNER ${APP_USER}`);
    console.log(`✔ Banco ${APP_DB} criado (dono: ${APP_USER}).`);
  } else {
    await su.query(`ALTER DATABASE ${APP_DB} OWNER TO ${APP_USER}`);
    console.log(`✔ Banco ${APP_DB} já existia; dono ajustado para ${APP_USER}.`);
  }
  await su.end();

  const url = `postgres://${APP_USER}:${appPass}@localhost:${port}/${APP_DB}`;
  await writeEnv(url);
  await ensureSchemaAndSeed(port, APP_USER, appPass);
  done(port);
}

function done(port) {
  rl.close();
  console.log(
    `\nPronto! Banco do MarketMe configurado na porta ${port}.\n` +
    'A senha gerada ficou salva apenas no .env (não precisa memorizá-la).\n' +
    'Agora rode: npm start',
  );
}

main().catch((err) => {
  console.error('Erro inesperado:', err.message ?? err);
  process.exit(1);
});
