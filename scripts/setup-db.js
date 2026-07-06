// Configuração automática do banco do MarketMe (Windows/Linux/macOS).
// Uso: npm run db:setup
//
// O que faz, nesta ordem:
//   1. Procura instâncias do PostgreSQL nas portas comuns (5432-5435).
//   2. Testa pointer/sysadmin em cada uma; se funcionar, usa essa.
//   3. Se não funcionar em nenhuma, pede a senha do superusuário
//      "postgres" e cria o usuário/banco que faltarem — sem alterar
//      usuários existentes de outros projetos.
//   4. Grava o DATABASE_URL correto no .env e cria as tabelas
//      (e os dados de exemplo, apenas se o banco estiver vazio).
import net from 'node:net';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const APP_USER = 'pointer';
const APP_PASS = 'sysadmin';
const APP_DB = 'marketme';
const PORTS = [5432, 5433, 5434, 5435];

const root = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const rl = createInterface({ input: process.stdin, output: process.stdout });

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
  console.log(`✔ .env atualizado: ${line}`);
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
  console.log(`Portas com PostgreSQL: ${open.join(', ')}`);

  // 1) Alguma instância já aceita pointer/sysadmin?
  for (const port of open) {
    for (const database of [APP_DB, 'postgres']) {
      const c = await tryConnect({ user: APP_USER, password: APP_PASS, port, database });
      if (typeof c !== 'string') {
        console.log(`✔ Usuário ${APP_USER} funciona na porta ${port}.`);
        if (database !== APP_DB) {
          // usuário ok, mas o banco marketme ainda não existe
          const r = await c.query(
            'SELECT 1 FROM pg_database WHERE datname = $1', [APP_DB]);
          if (r.rowCount === 0) {
            try {
              await c.query(`CREATE DATABASE ${APP_DB} OWNER ${APP_USER}`);
              console.log(`✔ Banco ${APP_DB} criado.`);
            } catch {
              await c.end();
              console.log(`O usuário ${APP_USER} não pode criar bancos aqui; vou precisar do superusuário.`);
              return superuserFlow(port);
            }
          }
        }
        await c.end();
        const url = `postgres://${APP_USER}:${APP_PASS}@localhost:${port}/${APP_DB}`;
        await writeEnv(url);
        await ensureSchemaAndSeed(port, APP_USER, APP_PASS);
        return done(port);
      }
    }
  }

  // 2) Nenhuma aceitou: escolher instância e usar o superusuário
  let port = open[0];
  if (open.length > 1) {
    const ans = await rl.question(
      `Em qual porta instalar o MarketMe? [${open.join('/')}] (Enter = ${open[0]}): `,
    );
    const n = Number(ans.trim());
    if (open.includes(n)) port = n;
  }
  return superuserFlow(port);
}

async function superuserFlow(port) {
  console.log(`\nConfigurando via superusuário na porta ${port}.`);
  const superPass = await rl.question(
    'Senha do usuário "postgres" (a definida na instalação do PostgreSQL): ',
  );
  const su = await tryConnect({
    user: 'postgres', password: superPass.trim(), port, database: 'postgres',
  });
  if (typeof su === 'string') {
    console.error(`Não conectou como postgres (${su}). Confira a senha e rode de novo.`);
    process.exit(1);
  }

  let appUser = APP_USER;
  const role = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_USER]);
  if (role.rowCount === 0) {
    await su.query(`CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}' CREATEDB`);
    console.log(`✔ Usuário ${APP_USER} criado.`);
  } else {
    // pointer existe com OUTRA senha — provavelmente é do seu outro
    // projeto. Não mexemos nele: criamos um usuário só do MarketMe.
    appUser = 'marketme_app';
    const r2 = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser]);
    if (r2.rowCount === 0) {
      await su.query(`CREATE ROLE ${appUser} LOGIN PASSWORD '${APP_PASS}' CREATEDB`);
    } else {
      await su.query(`ALTER ROLE ${appUser} WITH LOGIN PASSWORD '${APP_PASS}'`);
    }
    console.log(
      `⚠ O usuário ${APP_USER} já existe nesta instância com outra senha ` +
      `(deve ser do seu outro projeto — não foi alterado).\n` +
      `✔ Criado usuário exclusivo do MarketMe: ${appUser} (senha ${APP_PASS}).`,
    );
  }

  const db = await su.query('SELECT 1 FROM pg_database WHERE datname = $1', [APP_DB]);
  if (db.rowCount === 0) {
    await su.query(`CREATE DATABASE ${APP_DB} OWNER ${appUser}`);
    console.log(`✔ Banco ${APP_DB} criado (dono: ${appUser}).`);
  } else {
    await su.query(`ALTER DATABASE ${APP_DB} OWNER TO ${appUser}`);
    console.log(`✔ Banco ${APP_DB} já existia; dono ajustado para ${appUser}.`);
  }
  await su.end();

  const url = `postgres://${appUser}:${APP_PASS}@localhost:${port}/${APP_DB}`;
  await writeEnv(url);
  await ensureSchemaAndSeed(port, appUser, APP_PASS);
  return done(port);
}

function done(port) {
  rl.close();
  console.log(
    `\nPronto! Banco do MarketMe configurado na porta ${port}.\n` +
    'Agora rode: npm start\n' +
    '(seu outro projeto e o banco dele não foram tocados)',
  );
}

main().catch((err) => {
  console.error('Erro inesperado:', err.message ?? err);
  process.exit(1);
});
