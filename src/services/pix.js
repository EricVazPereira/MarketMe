import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

// txid Pix: alfanumérico, até 25 caracteres (padrão Bacen para cobrança)
export function generateTxid() {
  return randomBytes(16).toString('hex').slice(0, 25).toUpperCase();
}

function crc16(payload) {
  let crc = 0xffff;
  for (const ch of payload) {
    crc ^= ch.charCodeAt(0) << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const emv = (id, value) =>
  id + String(value.length).padStart(2, '0') + value;

// Monta o BR Code (Pix copia-e-cola) dinâmico de um pedido, no formato
// EMV-MPM usado pelos PSPs. O QR do app é gerado a partir desta string.
export function buildBrCode({ txid, amount }) {
  const { key, merchantName, merchantCity } = config.pix;
  const merchantAccountInfo = emv('00', 'br.gov.bcb.pix') + emv('01', key);
  let payload =
    emv('00', '01') +
    emv('26', merchantAccountInfo) +
    emv('52', '5411') + // MCC: grocery stores
    emv('53', '986') + // BRL
    emv('54', amount.toFixed(2)) +
    emv('58', 'BR') +
    emv('59', merchantName.slice(0, 25)) +
    emv('60', merchantCity.slice(0, 15)) +
    emv('62', emv('05', txid));
  payload += '6304';
  return payload + crc16(payload);
}
