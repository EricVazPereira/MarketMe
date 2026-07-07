import { Router } from 'express';
import { config } from '../config.js';
import { fbQuery, fbText, ident } from '../firebird.js';
import { notFound, wrap } from '../errors.js';

export const catalogRouter = Router();

const erp = config.erp;
const dbPath = (req) => req.get('x-db-path') || undefined;

const productSelect = () =>
  `SELECT ${ident(erp.produtoCodigo)} AS CODE,
          ${ident(erp.produtoEan)} AS EAN,
          ${ident(erp.produtoNome)} AS PNAME,
          ${ident(erp.produtoPreco)} AS PRICE
     FROM ${ident(erp.produtoTable)}`;

const mapProduct = (r) => ({
  product_code: String(r.CODE),
  ean: fbText(r.EAN),
  name: fbText(r.PNAME),
  price: Number(r.PRICE),
  unit_type: 'un',
  available: null, // estoque é controlado pelo ERP nesta fase
});

// Lojas = registros da tabela EMPRESA do ERP (Nome Fantasia).
// Multi-loja de verdade (estoque/preço por unidade) fica para a fase da API.
catalogRouter.get(
  '/stores',
  wrap(async (req, res) => {
    const rows = await fbQuery(
      `SELECT ${ident(erp.empresaId)} AS ID,
              ${ident(erp.empresaFantasia)} AS FANTASIA
         FROM ${ident(erp.empresaTable)}
        ORDER BY 2`,
      [],
      dbPath(req),
    );
    res.json({
      stores: rows.map((r) => ({ id: Number(r.ID), name: fbText(r.FANTASIA) })),
    });
  }),
);

// Catálogo: primeiros produtos do cadastro do ERP (com código de barras)
catalogRouter.get(
  '/stores/:storeId/catalog',
  wrap(async (req, res) => {
    const rows = await fbQuery(
      `SELECT FIRST 200 * FROM (${productSelect()}) p
        WHERE p.EAN IS NOT NULL AND p.EAN <> ''
        ORDER BY p.PNAME`,
      [],
      dbPath(req),
    );
    res.json({
      store: { id: Number(req.params.storeId) },
      products: rows.map(mapProduct),
    });
  }),
);

// Scan: resolve o código de barras no cadastro de produtos do ERP
catalogRouter.get(
  '/stores/:storeId/products/ean/:ean',
  wrap(async (req, res) => {
    const rows = await fbQuery(
      `SELECT FIRST 1 * FROM (${productSelect()}) p WHERE p.EAN = ?`,
      [req.params.ean],
      dbPath(req),
    );
    if (rows.length === 0)
      throw notFound('produto não encontrado no cadastro do ERP');
    res.json(mapProduct(rows[0]));
  }),
);

// Modo balança: etiqueta "2" + código do produto (6 dígitos) + peso.
// Resolve o prefixo para o produto pesável correspondente no ERP.
catalogRouter.get(
  '/stores/:storeId/products/scale/:prefix',
  wrap(async (req, res) => {
    const { prefix } = req.params;
    if (!/^2\d{6}$/.test(prefix))
      return res
        .status(400)
        .json({ error: 'prefixo de balança deve ser 2 + 6 dígitos' });
    const rows = await fbQuery(
      `SELECT FIRST 1 * FROM (${productSelect()}) p
        WHERE p.EAN LIKE ? ORDER BY p.EAN`,
      [`${prefix}%`],
      dbPath(req),
    );
    if (rows.length === 0)
      throw notFound('produto de balança não encontrado no cadastro do ERP');
    res.json({ ...mapProduct(rows[0]), unit_type: 'kg' });
  }),
);
