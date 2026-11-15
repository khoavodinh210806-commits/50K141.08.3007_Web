import 'dotenv/config';
import express, { ErrorRequestHandler } from 'express';
import cors from 'cors';
import { pool } from './inventory/db';
import { HttpError } from './inventory/http';
import router from './inventory/routes';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must have at least 32 characters');
if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) throw new Error('CORS_ORIGIN is required in production');

const app = express();
app.use(cors({origin: process.env.CORS_ORIGIN?.split(',').map(origin => origin.trim()).filter(Boolean) || true}));
app.use(express.json({limit:'2mb'}));
app.use('/api', router);
app.use((_req,res)=>{res.status(404).json({error:'Không tìm thấy API'});});
const errors: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({error:status === 500 ? 'Lỗi máy chủ' : err.message});
};
app.use(errors);
const port = Number(process.env.PORT || 4000);
pool().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Trình Cà Phê API listening on ${port}`))).catch(e=>{console.error('PostgreSQL unavailable',e);process.exit(1)});
