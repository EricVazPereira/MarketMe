import Firebird from 'node-firebird';
import { config } from './config.js';
import { HttpError } from './errors.js';

// Identificadores (tabelas/campos) vêm do .env — mesmo assim, valida
// para nunca interpolar algo fora do padrão de identificador Firebird.
export function ident(name) {
  if (!/^[A-Za-z][A-Za-z0-9_$]*$/.test(name))
    throw new Error(`identificador inválido na configuração do ERP: ${name}`);
  return name;
}

// Executa uma consulta no Firebird do ERP. `dbPath` (opcional) vem do
// header x-db-path — o campo "diretório do banco de dados" do app.
// Uma conexão por consulta: simples e suficiente para o volume de um
// mercado de condomínio; pool entra na fase da API.
export function fbQuery(sql, params = [], dbPath) {
  const options = {
    host: config.firebird.host,
    port: config.firebird.port,
    database: dbPath || config.firebird.database,
    user: config.firebird.user,
    password: config.firebird.password,
    charset: 'UTF8',
  };
  return new Promise((resolve, reject) => {
    Firebird.attach(options, (err, db) => {
      if (err)
        return reject(
          new HttpError(
            502,
            `sem conexão com o banco Firebird (${options.database}): ${err.message}`,
          ),
        );
      db.query(sql, params, (qErr, rows) => {
        db.detach();
        if (qErr)
          return reject(
            new HttpError(502, `erro na consulta ao ERP: ${qErr.message}`),
          );
        resolve(rows ?? []);
      });
    });
  });
}

// Strings do Firebird podem vir como Buffer dependendo do charset
export const fbText = (v) =>
  Buffer.isBuffer(v) ? v.toString('utf8').trim() : (v ?? '').toString().trim();
