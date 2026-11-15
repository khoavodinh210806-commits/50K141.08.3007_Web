import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { one, query } from './db';

export type Role = 'chucuahang' | 'quanly' | 'ketoan' | 'nhanvien';
export interface Actor { id: string; username: string; name: string; role: Role; branchIds: string[] }
export interface AuthRequest extends Request { actor?: Actor }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
export function handler(fn: (req: AuthRequest, res: Response) => Promise<unknown>) {
  return (req: AuthRequest, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };
}
export async function auth(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return fail(401, 'Vui lòng đăng nhập');
    const data = jwt.verify(token, process.env.JWT_SECRET || '') as jwt.JwtPayload;
    if (!data.jti) return fail(401, 'Phiên đăng nhập không hợp lệ');
    const session = await one<{id:string}>(`SELECT id FROM app.auth_sessions WHERE id=@id AND user_id=@user
      AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP`, {id:data.jti,user:data.sub});
    if (!session) return fail(401, 'Phiên đăng nhập đã kết thúc');
    const user = await one<{id:string;username:string;name:string;role:Role;active:boolean}>(
      'SELECT id,username,name,role,active FROM app.users WHERE id=@id', { id: data.sub });
    if (!user?.active) return fail(401, 'Phiên đăng nhập không hợp lệ');
    const branches = await query<{branch_id:string}>('SELECT branch_id FROM app.user_branches WHERE user_id=@id', {id:user.id});
    req.actor = { id:user.id, username:user.username, name:user.name, role:user.role, branchIds:branches.map(b=>b.branch_id) };
    next();
  } catch (e) { next(e instanceof jwt.JsonWebTokenError ? new HttpError(401,'Phiên đăng nhập không hợp lệ') : e); }
}
export function roles(...allowed: Role[]) { return (req: AuthRequest, _res: Response, next: NextFunction) => {
  if (!req.actor || !allowed.includes(req.actor.role)) return next(new HttpError(403,'Không có quyền thực hiện'));
  next();
}; }
export function branch(req: AuthRequest, id: string) {
  if (req.actor?.role !== 'chucuahang' && !req.actor?.branchIds.includes(id)) fail(403,'Không có quyền truy cập chi nhánh');
}
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}
