import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { auth, AuthRequest, branch, fail, handler, parse, roles } from './http';
import { one, query, transaction, txQuery, DbTransaction } from './db';

const r = Router();
const id = () => randomUUID();
const codeSequences = {
  NVL: 'code_nvl_seq', MON: 'code_mon_seq', PNK: 'code_pnk_seq',
  PXK: 'code_pxk_seq', PKK: 'code_pkk_seq', CT: 'code_ct_seq',
  'NVL-DC': 'code_nvl_dc_seq', DC: 'code_dc_seq', PD: 'code_pd_seq', BH: 'code_bh_seq',
} as const;
async function code(tx:DbTransaction,prefix:keyof typeof codeSequences,width=4) {
  const sequence=codeSequences[prefix];
  const result=await txQuery<{value:number}>(tx,`SELECT nextval('app.${sequence}') AS value`);
  return `${prefix}-${String(result.recordset[0].value).padStart(width,'0')}`;
}
const nonneg = z.number().finite().nonnegative();
const pos = z.number().finite().positive();
const qtyItem = z.object({materialId:z.string().min(1),quantity:pos});
const owner = roles('chucuahang');
const manager = roles('chucuahang','quanly');
const salesActor = roles('chucuahang','quanly');
const stockActor = roles('chucuahang','quanly','nhanvien');
const actor = (req:AuthRequest) => req.actor!;
const json = (value:unknown) => JSON.stringify(value);

async function audit(tx:DbTransaction, req:AuthRequest, action:string, entity:string, entityId:string, before:unknown=null, after:unknown=null, reason?:string) {
  await txQuery(tx, `INSERT INTO app.audit_logs(id,actor_id,action,entity_type,entity_id,before_json,after_json,reason)
    VALUES(@id,@actor,@action,@entity,@entityId,@before,@after,@reason)`,
    {id:id(),actor:actor(req).id,action,entity,entityId,before:before==null?null:json(before),after:after==null?null:json(after),reason});
}
async function movement(tx:DbTransaction, req:AuthRequest, branchId:string, materialId:string, delta:number, sourceType:string, sourceId:string, lineId:string) {
  const prior = await txQuery<{quantity:number}>(tx, `SELECT quantity FROM app.branch_stock
    WHERE branch_id=@branch AND material_id=@material`,{branch:branchId,material:materialId});
  const current = Number(prior.recordset[0]?.quantity || 0);
  const next = Math.round((current + delta)*10000)/10000;
  if (next < 0) fail(409,'Tồn kho không đủ');
  if (prior.recordset.length) await txQuery(tx,`UPDATE app.branch_stock SET quantity=@next,updated_at=CURRENT_TIMESTAMP WHERE branch_id=@branch AND material_id=@material`,{next,branch:branchId,material:materialId});
  else await txQuery(tx,`INSERT INTO app.branch_stock(branch_id,material_id,quantity) VALUES(@branch,@material,@next)`,{branch:branchId,material:materialId,next});
  await txQuery(tx,`INSERT INTO app.stock_movements(id,branch_id,material_id,delta,balance_after,source_type,source_id,source_line_id,created_by)
    VALUES(@id,@branch,@material,@delta,@next,@sourceType,@sourceId,@lineId,@user)`,
    {id:id(),branch:branchId,material:materialId,delta,next,sourceType,sourceId,lineId,user:actor(req).id});
}
async function approval(tx:DbTransaction, req:AuthRequest, type:string, action:string, referenceId:string, branchId:string|null, payload:unknown, reason:string) {
  const prefix = type === 'recipe' ? 'CT' : type === 'material' || type === 'threshold'
    ? 'NVL-DC' : type === 'stock_adjustment' ? 'DC' : 'PD';
  const approvalId=await code(tx,prefix);
  await txQuery(tx,`INSERT INTO app.approval_requests(id,type,action,reference_id,branch_id,requester_id,payload,reason)
    VALUES(@id,@type,@action,@referenceId,@branchId,@requester,@payload,@reason)`,
    {id:approvalId,type,action,referenceId,branchId,requester:actor(req).id,payload:json(payload),reason});
  return approvalId;
}
async function materialRows(branchId?:string) {
  const rows=await query<any>(`SELECT m.id,m.code,m.name,m.category,m.unit,m.standard_price AS standardPrice,m.allowed_loss_percent AS allowedLossPercent,m.allowed_loss_quantity AS allowedLossQuantity,
    m.description,m.status,m.deactivation_reason AS deactivationReason,s.name AS supplier,
    br.id AS branchId,COALESCE(b.quantity,0) AS stock,COALESCE(t.minimum_quantity,0) AS minimum
    FROM app.materials m LEFT JOIN app.suppliers s ON s.id=m.supplier_id
    CROSS JOIN app.branches br
    LEFT JOIN app.branch_stock b ON b.material_id=m.id AND b.branch_id=br.id
    LEFT JOIN app.branch_thresholds t ON t.material_id=m.id AND t.branch_id=br.id
    WHERE (@branch IS NULL OR br.id=@branch) ORDER BY m.name`,{branch:branchId||null});
  const map=new Map<string,any>();
  for(const row of rows) {
    if(!map.has(row.id)) map.set(row.id,{id:row.id,code:row.code,name:row.name,category:row.category,unit:row.unit,
      standardPrice:Number(row.standardPrice),allowedLossPercent:Number(row.allowedLossPercent),allowedLossQuantity:Number(row.allowedLossQuantity),description:row.description,
      status:row.status,supplier:row.supplier,deactivationReason:row.deactivationReason,stocks:{},minStocks:{}});
    if(row.branchId) {map.get(row.id).stocks[row.branchId]=Number(row.stock);map.get(row.id).minStocks[row.branchId]=Number(row.minimum);}
  }
  return [...map.values()];
}

r.get('/health',handler(async(_req,res)=>{await query('SELECT 1 AS ok');res.json({status:'ok',database:'postgresql'});}));
r.post('/auth/login',handler(async(req,res)=>{
  const body=parse(z.object({username:z.string().min(1),password:z.string().min(1)}),req.body);
  const user=await one<any>('SELECT * FROM app.users WHERE username=@username AND active=true',{username:body.username});
  if(!user || !await bcrypt.compare(body.password,user.password_hash)) fail(401,'Tên đăng nhập hoặc mật khẩu không đúng');
  const branches=await query<{branch_id:string}>('SELECT branch_id FROM app.user_branches WHERE user_id=@id',{id:user.id});
  const sessionId=id();
  const token=jwt.sign({role:user.role},process.env.JWT_SECRET||'',{subject:user.id,jwtid:sessionId,expiresIn:'12h'});
  await query(`INSERT INTO app.auth_sessions(id,user_id,expires_at) VALUES(@id,@user,CURRENT_TIMESTAMP + interval '12 hours')`,
    {id:sessionId,user:user.id});
  res.json({token,user:{id:user.id,username:user.username,name:user.name,role:user.role,roleLabel:{chucuahang:'Chủ cửa hàng',quanly:'Quản lý',ketoan:'Kế toán',nhanvien:'Nhân viên'}[user.role as 'chucuahang'|'quanly'|'ketoan'|'nhanvien'],branchIds:branches.map(b=>b.branch_id)}});
}));
r.use(auth);
r.get('/auth/me',handler(async(req,res)=>res.json(actor(req))));
r.get('/users',handler(async(_req,res)=>res.json(await query('SELECT id,username,name,role FROM app.users WHERE active=true ORDER BY name'))));
r.post('/auth/logout',handler(async(req,res)=>{
  const token=req.headers.authorization?.replace(/^Bearer\s+/i,'')||'';
  const data=jwt.verify(token,process.env.JWT_SECRET||'') as jwt.JwtPayload;
  await query('UPDATE app.auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=@id AND user_id=@user',
    {id:data.jti,user:actor(req).id});
  res.status(204).end();
}));
r.get('/branches',handler(async(req,res)=>{
  const rows=await query<any>(`SELECT b.id,b.name,b.address,b.phone,b.is_main AS isMain FROM app.branches b
    WHERE @owner=true OR EXISTS(SELECT 1 FROM app.user_branches ub WHERE ub.branch_id=b.id AND ub.user_id=@user)
    ORDER BY b.name`,{owner:actor(req).role==='chucuahang',user:actor(req).id});res.json(rows);
}));
r.get('/suppliers',handler(async(_req,res)=>res.json(await query('SELECT * FROM app.suppliers ORDER BY name'))));
r.post('/suppliers',manager,handler(async(req,res)=>{
  const {name}=parse(z.object({name:z.string().trim().min(1)}),req.body);
  const existing=await one<{id:string;name:string}>('SELECT id,name FROM app.suppliers WHERE LOWER(name)=LOWER(@name)',{name});
  if(existing)return res.json(existing);
  const supplierId=id();
  await query('INSERT INTO app.suppliers(id,name) VALUES(@id,@name)',{id:supplierId,name});
  res.status(201).json({id:supplierId,name});
}));
r.get('/materials',handler(async(req,res)=>{
  const branchId=String(req.query.branchId||'');if(branchId)branch(req,branchId);
  const rows=await materialRows(branchId||undefined);
  if(actor(req).role==='chucuahang') return res.json(rows);
  res.json(rows.map(m=>({...m,stocks:actor(req).role==='nhanvien'?{}:Object.fromEntries(Object.entries(m.stocks).filter(([b])=>actor(req).branchIds.includes(b))),
    minStocks:Object.fromEntries(Object.entries(m.minStocks).filter(([b])=>actor(req).branchIds.includes(b)))})));
}));
r.get('/materials/:id',handler(async(req,res)=>{
  const m=(await materialRows()).find(x=>x.id===req.params.id);if(!m)fail(404,'Không tìm thấy nguyên vật liệu');
  if(actor(req).role!=='chucuahang'){m.stocks=actor(req).role==='nhanvien'?{}:Object.fromEntries(Object.entries(m.stocks).filter(([b])=>actor(req).branchIds.includes(b)));m.minStocks=Object.fromEntries(Object.entries(m.minStocks).filter(([b])=>actor(req).branchIds.includes(b)));}
  res.json(m);
}));
const materialSchema=z.object({name:z.string().trim().min(1),category:z.string().min(1),unit:z.string().min(1),standardPrice:nonneg.default(0),
  allowedLossPercent:nonneg.default(0),allowedLossQuantity:nonneg.default(0),supplierId:z.string().optional(),description:z.string().optional()});
r.post('/materials',manager,handler(async(req,res)=>{
  const body=parse(materialSchema,req.body), mid=id();
  let matCode='';
  await transaction(async tx=>{
    matCode=await code(tx,'NVL',3);
    const status=actor(req).role==='chucuahang'?'active':'pending';
    await txQuery(tx,`INSERT INTO app.materials(id,code,name,category,unit,standard_price,allowed_loss_percent,allowed_loss_quantity,supplier_id,description,status)
      VALUES(@id,@code,@name,@category,@unit,@price,@loss,@lossQuantity,@supplier,@description,@status)`,
      {id:mid,code:matCode,name:body.name,category:body.category,unit:body.unit,price:body.standardPrice,loss:body.allowedLossPercent,lossQuantity:body.allowedLossQuantity,supplier:body.supplierId||null,description:body.description||null,status});
    await txQuery(tx,`INSERT INTO app.branch_stock(branch_id,material_id,quantity) SELECT id,@material,0 FROM app.branches`,{material:mid});
    await txQuery(tx,`INSERT INTO app.branch_thresholds(branch_id,material_id,minimum_quantity) SELECT id,@material,0 FROM app.branches`,{material:mid});
    if(status==='pending')await approval(tx,req,'material','create',mid,null,body,'Tạo nguyên vật liệu');
    await audit(tx,req,'create','material',mid,null,body);
  });res.status(201).json({id:mid,code:matCode,status:actor(req).role==='chucuahang'?'active':'pending'});
}));
r.patch('/materials/:id',manager,handler(async(req,res)=>{
  const body=parse(materialSchema.partial().refine(x=>Object.keys(x).length>0),req.body);
  const old=await one<any>('SELECT * FROM app.materials WHERE id=@id',{id:req.params.id});if(!old)fail(404,'Không tìm thấy nguyên vật liệu');
  if(actor(req).role!=='chucuahang') {
    await transaction(async tx=>{await approval(tx,req,'material','update',req.params.id,null,body,'Sửa nguyên vật liệu');await audit(tx,req,'propose_update','material',req.params.id,old,body);});
    return res.status(202).json({status:'pending'});
  }
  await transaction(async tx=>{await txQuery(tx,`UPDATE app.materials SET name=COALESCE(@name,name),category=COALESCE(@category,category),unit=COALESCE(@unit,unit),
    standard_price=COALESCE(@price,standard_price),allowed_loss_percent=COALESCE(@loss,allowed_loss_percent),allowed_loss_quantity=COALESCE(@lossQuantity,allowed_loss_quantity),
    supplier_id=COALESCE(@supplier,supplier_id),description=COALESCE(@description,description) WHERE id=@id`,
    {id:req.params.id,name:body.name,category:body.category,unit:body.unit,price:body.standardPrice,loss:body.allowedLossPercent,lossQuantity:body.allowedLossQuantity,supplier:body.supplierId,description:body.description});
    await audit(tx,req,'update','material',req.params.id,old,body);});res.json({id:req.params.id,status:'active'});
}));
r.post('/materials/:id/deactivate',manager,handler(async(req,res)=>{
  const body=parse(z.object({reason:z.string().trim().min(1)}),req.body);
  const material=await one<any>('SELECT id FROM app.materials WHERE id=@id',{id:req.params.id});if(!material)fail(404,'Không tìm thấy nguyên vật liệu');
  const stock=await one<{total:number}>('SELECT COALESCE(SUM(quantity),0) AS total FROM app.branch_stock WHERE material_id=@id',{id:req.params.id});
  if(Number(stock?.total)>0)fail(409,'Chỉ có thể ngừng sử dụng khi tồn kho bằng 0');
  const used=await one<any>(`SELECT 1 FROM app.recipe_ingredients i JOIN app.recipes r ON r.current_version_id=i.version_id
    WHERE i.material_id=@id AND r.status='active' LIMIT 1`,{id:req.params.id});
  if(used)fail(409,'Nguyên vật liệu đang được dùng trong công thức có hiệu lực');
  await transaction(async tx=>{if(actor(req).role==='chucuahang')await txQuery(tx,`UPDATE app.materials SET status='inactive',deactivation_reason=@reason WHERE id=@id`,{id:req.params.id,reason:body.reason});
    else await approval(tx,req,'material','deactivate',req.params.id,null,{},body.reason);
    await audit(tx,req,'deactivate','material',req.params.id,null,null,body.reason);});res.json({status:actor(req).role==='chucuahang'?'inactive':'pending'});
}));
r.post('/materials/:id/reactivate',owner,handler(async(req,res)=>{
  const material=await one<any>('SELECT id,status FROM app.materials WHERE id=@id',{id:req.params.id});
  if(!material)fail(404,'Không tìm thấy nguyên vật liệu');
  if(material.status!=='inactive')fail(409,'Nguyên vật liệu đã đang sử dụng');
  await transaction(async tx=>{
    await txQuery(tx,`UPDATE app.materials SET status='active',deactivation_reason=NULL WHERE id=@id`,{id:req.params.id});
    await audit(tx,req,'reactivate','material',req.params.id,material,{status:'active'});
  });
  res.json({status:'active'});
}));
r.get('/thresholds',handler(async(req,res)=>{
  const branchId=String(req.query.branchId||'');if(branchId)branch(req,branchId);
  const rows=await query<any>(`SELECT t.branch_id AS branchId,t.material_id AS materialId,t.minimum_quantity AS minimumQuantity
    FROM app.branch_thresholds t WHERE @branch IS NULL OR t.branch_id=@branch`,{branch:branchId||null});
  res.json(actor(req).role==='chucuahang'?rows:rows.filter(x=>actor(req).branchIds.includes(x.branchId)));
}));
r.post('/thresholds/requests',manager,handler(async(req,res)=>{
  const body=parse(z.object({branchId:z.string(),materialId:z.string(),minimumQuantity:nonneg,reason:z.string().trim().min(1)}),req.body);branch(req,body.branchId);
  await transaction(async tx=>{
    if(actor(req).role==='chucuahang')await txQuery(tx,`INSERT INTO app.branch_thresholds(branch_id,material_id,minimum_quantity) VALUES(@branch,@material,@qty)
        ON CONFLICT(branch_id,material_id) DO UPDATE SET minimum_quantity=EXCLUDED.minimum_quantity`,
      {branch:body.branchId,material:body.materialId,qty:body.minimumQuantity});
    else await approval(tx,req,'threshold','update',body.materialId,body.branchId,{minimumQuantity:body.minimumQuantity},body.reason);
    await audit(tx,req,'threshold_change','material',body.materialId,null,body,body.reason);
  });res.status(actor(req).role==='chucuahang'?200:202).json({status:actor(req).role==='chucuahang'?'active':'pending'});
}));

async function recipeDetail(recipeId:string) {
  const recipe=await one<any>(`SELECT id,code,name,category,size,sale_price AS price,status,note,current_version_id AS currentVersionId,updated_at AS updatedAt
    FROM app.recipes WHERE id=@id`,{id:recipeId});
  if(!recipe)return undefined;
  const versions=await query<any>(`SELECT id,version_no AS versionNo,status,created_at AS createdAt,approved_at AS approvedAt FROM app.recipe_versions WHERE recipe_id=@id ORDER BY version_no DESC`,{id:recipeId});
  const active=versions.find(v=>v.id===recipe.currentVersionId) || (!recipe.currentVersionId ? versions[0] : undefined);
  const ingredients=active?await query<any>(`SELECT i.material_id AS materialId,m.name AS materialName,i.quantity,m.unit,m.standard_price AS standardPrice
    FROM app.recipe_ingredients i JOIN app.materials m ON m.id=i.material_id WHERE i.version_id=@id`,{id:active.id}):[];
  return {...recipe,price:Number(recipe.price),ingredients:ingredients.map(i=>({materialId:i.materialId,materialName:i.materialName,quantity:Number(i.quantity),unit:i.unit,costEstimate:Number(i.quantity)*Number(i.standardPrice)})),versions};
}
r.get('/recipes',handler(async(_req,res)=>{
  const rows=await query<{id:string}>('SELECT id FROM app.recipes ORDER BY name');res.json(await Promise.all(rows.map(x=>recipeDetail(x.id))));
}));
r.get('/recipes/:id',handler(async(req,res)=>{const data=await recipeDetail(req.params.id);if(!data)fail(404,'Không tìm thấy công thức');res.json(data);}));
r.get('/recipes/:id/versions/:versionId',handler(async(req,res)=>{
  const version=await one<any>(`SELECT id,recipe_id AS recipeId,version_no AS versionNo,status,created_by AS createdBy,
    created_at AS createdAt,approved_by AS approvedBy,approved_at AS approvedAt,note
    FROM app.recipe_versions WHERE id=@version AND recipe_id=@recipe`,{version:req.params.versionId,recipe:req.params.id});
  if(!version)fail(404,'Không tìm thấy phiên bản công thức');
  const ingredients=await query<any>(`SELECT i.material_id AS materialId,m.name AS materialName,m.unit,i.quantity
    FROM app.recipe_ingredients i JOIN app.materials m ON m.id=i.material_id WHERE i.version_id=@id`,{id:version.id});
  res.json({...version,ingredients});
}));
const recipeSchema=z.object({name:z.string().trim().min(1),category:z.string().min(1),price:nonneg,
  note:z.string().optional(),ingredients:z.array(qtyItem).min(1)});
async function addRecipeVersion(tx:DbTransaction,req:AuthRequest,recipeId:string,items:{materialId:string;quantity:number}[],note:string|undefined,status:'active'|'pending') {
  const versionId=id();
  const last=await txQuery<{lastNo:number}>(tx,`SELECT COALESCE(MAX(version_no),0) AS lastNo FROM app.recipe_versions WHERE recipe_id=@id`,{id:recipeId});
  await txQuery(tx,`INSERT INTO app.recipe_versions(id,recipe_id,version_no,status,created_by,approved_by,approved_at,note)
    VALUES(@id,@recipe,@version,@status,@user,@approvedBy,@approvedAt,@note)`,
    {id:versionId,recipe:recipeId,version:Number(last.recordset[0].lastNo)+1,status,user:actor(req).id,approvedBy:status==='active'?actor(req).id:null,approvedAt:status==='active'?new Date():null,note:note||null});
  for(const item of items)await txQuery(tx,`INSERT INTO app.recipe_ingredients(version_id,material_id,quantity) VALUES(@version,@material,@qty)`,{version:versionId,material:item.materialId,qty:item.quantity});
  if(status==='active'){
    await txQuery(tx,`UPDATE app.recipe_versions SET status='superseded' WHERE recipe_id=@recipe AND id<>@version AND status='active'`,{recipe:recipeId,version:versionId});
    await txQuery(tx,`UPDATE app.recipes SET current_version_id=@version,status='active',updated_at=CURRENT_TIMESTAMP WHERE id=@recipe`,{version:versionId,recipe:recipeId});
  }
  return versionId;
}
r.post('/recipes',manager,handler(async(req,res)=>{
  const body=parse(recipeSchema,req.body),recipeId=id();
  let recipeCode='';
  if(new Set(body.ingredients.map(i=>i.materialId)).size!==body.ingredients.length)fail(400,'Nguyên vật liệu trong công thức bị trùng');
  const status=actor(req).role==='chucuahang'?'active':'pending';
  await transaction(async tx=>{
    recipeCode=await code(tx,'MON',3);
    await txQuery(tx,`INSERT INTO app.recipes(id,code,name,category,sale_price,status,note) VALUES(@id,@code,@name,@category,@price,@status,@note)`,
      {id:recipeId,code:recipeCode,name:body.name,category:body.category,price:body.price,status,note:body.note||null});
    const versionId=await addRecipeVersion(tx,req,recipeId,body.ingredients,body.note,status);
    if(status==='pending')await approval(tx,req,'recipe','create',recipeId,null,{versionId},'Tạo công thức');
    await audit(tx,req,'create','recipe',recipeId,null,body);
  });res.status(201).json({id:recipeId,code:recipeCode,status});
}));
r.patch('/recipes/:id',manager,handler(async(req,res)=>{
  const body=parse(recipeSchema,req.body);const old=await recipeDetail(req.params.id);if(!old)fail(404,'Không tìm thấy công thức');
  if(new Set(body.ingredients.map(i=>i.materialId)).size!==body.ingredients.length)fail(400,'Nguyên vật liệu trong công thức bị trùng');
  const status=actor(req).role==='chucuahang'?'active':'pending';
  await transaction(async tx=>{
    const versionId=await addRecipeVersion(tx,req,req.params.id,body.ingredients,body.note,status);
    if(status==='active')await txQuery(tx,`UPDATE app.recipes SET name=@name,category=@category,sale_price=@price,note=@note WHERE id=@id`,{id:req.params.id,name:body.name,category:body.category,price:body.price,note:body.note||null});
    else await approval(tx,req,'recipe','update',req.params.id,null,{versionId,name:body.name,category:body.category,price:body.price,note:body.note},'Sửa công thức');
    await audit(tx,req,status==='active'?'update':'propose_update','recipe',req.params.id,old,body);
  });res.status(status==='active'?200:202).json({id:req.params.id,status});
}));
r.post('/recipes/:id/deactivate',manager,handler(async(req,res)=>{
  const {reason}=parse(z.object({reason:z.string().trim().min(1)}),req.body);
  const old=await recipeDetail(req.params.id);if(!old)fail(404,'Không tìm thấy công thức');
  if(old.status!=='active')fail(409,'Công thức không còn hiệu lực');
  const pending=await one<any>(`SELECT id FROM app.approval_requests WHERE type='recipe' AND reference_id=@id AND status='pending'`,{id:req.params.id});
  if(pending)fail(409,'Công thức đã có đề xuất chờ duyệt');
  await transaction(async tx=>{
    if(actor(req).role==='chucuahang')await txQuery(tx,`UPDATE app.recipes SET status='inactive',updated_at=CURRENT_TIMESTAMP WHERE id=@id`,{id:req.params.id});
    else await approval(tx,req,'recipe','deactivate',req.params.id,null,{},reason);
    await audit(tx,req,'deactivate','recipe',req.params.id,old,null,reason);
  });res.status(actor(req).role==='chucuahang'?200:202).json({status:actor(req).role==='chucuahang'?'inactive':'pending'});
}));

async function slipItems(kind:'import'|'export',slipId:string) {
  const table=kind==='import'?'import_items':'export_items';
  const qty=kind==='import'?'planned_quantity AS plannedQuantity,received_good_quantity AS receivedGoodQuantity,unit_price AS unitPrice':'requested_quantity AS requestedQuantity,actual_quantity AS actualQuantity,unit_cost AS unitCost';
  return query<any>(`SELECT i.material_id AS materialId,m.name AS materialName,m.unit,${qty} FROM app.${table} i JOIN app.materials m ON m.id=i.material_id WHERE i.slip_id=@id`,{id:slipId});
}
async function slip(kind:'import'|'export',slipId:string) {
  const table=kind==='import'?'import_slips':'export_slips';
  const row=await one<any>(`SELECT * FROM app.${table} WHERE id=@id`,{id:slipId});
  if(!row)return undefined;
  const items=await slipItems(kind,slipId);
  if(kind==='export')return {...row,items};
  const receipts=await query<any>(`SELECT id,received_by AS receivedBy,received_at AS receivedAt
    FROM app.import_receipts WHERE slip_id=@id ORDER BY received_at`,{id:slipId});
  for(const receipt of receipts)receipt.items=await query<any>(`SELECT material_id AS materialId,received_quantity AS receivedQuantity,
    defect_quantity AS defectQuantity,defect_reason AS defectReason FROM app.import_receipt_items WHERE receipt_id=@id`,{id:receipt.id});
  return {...row,items,receipts};
}
const importSchema=z.object({branchId:z.string(),supplierId:z.string().optional(),expectedDate:z.string().optional(),note:z.string().optional(),
  items:z.array(z.object({materialId:z.string(),plannedQuantity:pos,unitPrice:nonneg})).min(1)});
r.get('/imports',handler(async(req,res)=>{
  const rows=await query<any>(`SELECT id,code,branch_id AS branchId,supplier_id AS supplierId,creator_id AS creatorId,
    expected_date AS expectedDate,status,note,created_at AS createdAt FROM app.import_slips ORDER BY created_at DESC`);
  res.json(actor(req).role==='chucuahang'?rows:rows.filter(x=>actor(req).branchIds.includes(x.branchId)));
}));
r.get('/imports/:id',handler(async(req,res)=>{const data=await slip('import',req.params.id);if(!data)fail(404,'Không tìm thấy phiếu nhập');branch(req,data.branch_id);res.json(data);}));
r.post('/imports',manager,handler(async(req,res)=>{
  const body=parse(importSchema,req.body);branch(req,body.branchId);
  if(new Set(body.items.map(i=>i.materialId)).size!==body.items.length)fail(400,'Nguyên vật liệu bị trùng');
  const slipId=id(),isOwner=actor(req).role==='chucuahang';
  let slipCode='';
  await transaction(async tx=>{
    slipCode=await code(tx,'PNK');
    await txQuery(tx,`INSERT INTO app.import_slips(id,code,branch_id,supplier_id,creator_id,expected_date,status,note)
      VALUES(@id,@code,@branch,@supplier,@creator,@date,@status,@note)`,
      {id:slipId,code:slipCode,branch:body.branchId,supplier:body.supplierId||null,creator:actor(req).id,date:body.expectedDate||null,status:isOwner?'approved':'pending_approval',note:body.note||null});
    for(const item of body.items)await txQuery(tx,`INSERT INTO app.import_items(slip_id,material_id,planned_quantity,unit_price) VALUES(@slip,@material,@qty,@price)`,
      {slip:slipId,material:item.materialId,qty:item.plannedQuantity,price:item.unitPrice});
    if(!isOwner)await approval(tx,req,'import_plan','approve',slipId,body.branchId,{},body.note||'Kế hoạch nhập hàng');
    await audit(tx,req,'create','import',slipId,null,body);
  });res.status(201).json({id:slipId,code:slipCode,status:isOwner?'approved':'pending_approval'});
}));
r.patch('/imports/:id',manager,handler(async(req,res)=>{
  const body=parse(importSchema,req.body),existing=await slip('import',req.params.id);
  if(!existing)fail(404,'Không tìm thấy phiếu nhập');branch(req,existing.branch_id);
  if(body.branchId!==existing.branch_id)fail(409,'Không thể đổi chi nhánh của phiếu');
  if(existing.status!=='pending_approval')fail(409,'Phiếu không còn được sửa');
  await transaction(async tx=>{
    await txQuery(tx,`UPDATE app.import_slips SET supplier_id=@supplier,expected_date=@date,note=@note,updated_at=CURRENT_TIMESTAMP WHERE id=@id`,
      {id:req.params.id,supplier:body.supplierId||null,date:body.expectedDate||null,note:body.note||null});
    await txQuery(tx,`DELETE FROM app.import_items WHERE slip_id=@id`,{id:req.params.id});
    for(const item of body.items)await txQuery(tx,`INSERT INTO app.import_items(slip_id,material_id,planned_quantity,unit_price) VALUES(@slip,@material,@qty,@price)`,
      {slip:req.params.id,material:item.materialId,qty:item.plannedQuantity,price:item.unitPrice});
    await audit(tx,req,'update','import',req.params.id,existing,body);
  });res.json({id:req.params.id,status:'pending_approval'});
}));
r.post('/imports/:id/receive',stockActor,handler(async(req,res)=>{
  const body=parse(z.object({idempotencyKey:z.string().min(8),items:z.array(z.object({materialId:z.string(),receivedQuantity:nonneg,defectQuantity:nonneg.default(0),defectReason:z.string().optional()})).min(1)}),req.body);
  if(new Set(body.items.map(i=>i.materialId)).size!==body.items.length)fail(400,'Nguyên vật liệu bị trùng');
  const result=await transaction(async tx=>{
    const locked=await txQuery<any>(tx,`SELECT * FROM app.import_slips WHERE id=@id`,{id:req.params.id});
    const current=locked.recordset[0];if(!current)fail(404,'Không tìm thấy phiếu nhập');branch(req,current.branch_id);
    const existing=await txQuery<any>(tx,`SELECT id,slip_id FROM app.import_receipts WHERE idempotency_key=@key`,{key:body.idempotencyKey});
    if(existing.recordset.length){
      if(existing.recordset[0].slip_id!==req.params.id)fail(409,'Mã chống gửi trùng đã dùng cho phiếu khác');
      return {id:existing.recordset[0].id,replayed:true};
    }
    if(!['approved','receiving','backorder'].includes(current.status))fail(409,'Phiếu chưa được duyệt hoặc đã hoàn thành');
    const receiptId=id();await txQuery(tx,`INSERT INTO app.import_receipts(id,slip_id,received_by,idempotency_key) VALUES(@id,@slip,@user,@key)`,
      {id:receiptId,slip:req.params.id,user:actor(req).id,key:body.idempotencyKey});
    for(const item of body.items){
      if(item.defectQuantity>item.receivedQuantity)fail(400,'Số lượng lỗi vượt số lượng nhận');
      if(item.defectQuantity>0&&!item.defectReason?.trim())fail(400,'Cần nhập lý do hàng lỗi');
      const prior=await txQuery<any>(tx,`SELECT planned_quantity,received_good_quantity FROM app.import_items WHERE slip_id=@slip AND material_id=@material`,{slip:req.params.id,material:item.materialId});
      if(!prior.recordset.length)fail(400,'Nguyên vật liệu không thuộc phiếu');
      if(item.receivedQuantity>Number(prior.recordset[0].planned_quantity)-Number(prior.recordset[0].received_good_quantity))
        fail(409,'Số lượng thực nhận vượt số lượng còn thiếu');
      const good=item.receivedQuantity-item.defectQuantity;
      if(Number(prior.recordset[0].received_good_quantity)+good>Number(prior.recordset[0].planned_quantity))fail(409,'Số lượng đạt vượt kế hoạch');
      await txQuery(tx,`INSERT INTO app.import_receipt_items(receipt_id,material_id,received_quantity,defect_quantity,defect_reason)
        VALUES(@receipt,@material,@received,@defect,@reason)`,{receipt:receiptId,material:item.materialId,received:item.receivedQuantity,defect:item.defectQuantity,reason:item.defectReason||null});
      await txQuery(tx,`UPDATE app.import_items SET received_good_quantity=received_good_quantity+@good WHERE slip_id=@slip AND material_id=@material`,{good,slip:req.params.id,material:item.materialId});
      if(good>0)await movement(tx,req,current.branch_id,item.materialId,good,'import_receipt',receiptId,`${receiptId}:${item.materialId}`);
    }
    const remain=await txQuery<any>(tx,`SELECT COUNT(*) AS n FROM app.import_items WHERE slip_id=@id AND received_good_quantity<planned_quantity`,{id:req.params.id});
    const status=Number(remain.recordset[0].n)===0?'completed':'backorder';
    await txQuery(tx,`UPDATE app.import_slips SET status=@status,updated_at=CURRENT_TIMESTAMP WHERE id=@id`,{id:req.params.id,status});
    await audit(tx,req,'receive','import',req.params.id,null,body);
    return {id:receiptId,status};
  });res.status(result.replayed?200:201).json(result);
}));
r.post('/imports/:id/cancel',manager,handler(async(req,res)=>{
  const {reason}=parse(z.object({reason:z.string().trim().min(1)}),req.body);
  await transaction(async tx=>{
    const row=(await txQuery<any>(tx,`SELECT * FROM app.import_slips WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!row)fail(404,'Không tìm thấy phiếu nhập');branch(req,row.branch_id);
    if(row.status!=='pending_approval')fail(409,'Chỉ hủy được phiếu chờ duyệt');
    await txQuery(tx,`UPDATE app.import_slips SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=@id`,{id:req.params.id});
    await txQuery(tx,`UPDATE app.approval_requests SET status='rejected',review_note=@reason,reviewed_by=@user,reviewed_at=CURRENT_TIMESTAMP
      WHERE type='import_plan' AND reference_id=@id AND status='pending'`,{id:req.params.id,reason,user:actor(req).id});
    await audit(tx,req,'cancel','import',req.params.id,row,null,reason);
  });res.json({status:'cancelled'});
}));

const exportSchema=z.object({branchId:z.string(),targetBranchId:z.string().optional(),type:z.enum(['cap_quay','huy_hong','chuyen_kho','khac']),
  reason:z.string().trim().min(1),items:z.array(z.object({materialId:z.string(),requestedQuantity:pos})).min(1)});
r.get('/exports',handler(async(req,res)=>{
  const rows=await query<any>(`SELECT id,code,branch_id AS branchId,target_branch_id AS targetBranchId,type,reason,status,
    creator_id AS creatorId,created_at AS createdAt FROM app.export_slips ORDER BY created_at DESC`);
  res.json(actor(req).role==='chucuahang'?rows:rows.filter(x=>actor(req).branchIds.includes(x.branchId)));
}));
r.get('/exports/:id',handler(async(req,res)=>{const data=await slip('export',req.params.id);if(!data)fail(404,'Không tìm thấy phiếu xuất');branch(req,data.branch_id);res.json(data);}));
r.post('/exports',manager,handler(async(req,res)=>{
  const body=parse(exportSchema,req.body);branch(req,body.branchId);
  if(body.type==='chuyen_kho'&&(!body.targetBranchId||body.targetBranchId===body.branchId))fail(400,'Cần chọn chi nhánh nhận khác chi nhánh xuất');
  if(new Set(body.items.map(i=>i.materialId)).size!==body.items.length)fail(400,'Nguyên vật liệu bị trùng');
  const slipId=id(),requiresApproval=body.type==='chuyen_kho'&&actor(req).role!=='chucuahang';
  let slipCode='';
  await transaction(async tx=>{
    slipCode=await code(tx,'PXK');
    for(const item of body.items){
      const stock=(await txQuery<any>(tx,`SELECT quantity FROM app.branch_stock WHERE branch_id=@branch AND material_id=@material`,{branch:body.branchId,material:item.materialId})).recordset[0];
      if(Number(stock?.quantity||0)<item.requestedQuantity)fail(409,'Số lượng xuất vượt tồn kho');
    }
    await txQuery(tx,`INSERT INTO app.export_slips(id,code,branch_id,target_branch_id,creator_id,type,status,reason)
      VALUES(@id,@code,@branch,@target,@creator,@type,@status,@reason)`,
      {id:slipId,code:slipCode,branch:body.branchId,target:body.targetBranchId||null,creator:actor(req).id,type:body.type,
       status:requiresApproval?'pending_approval':'pending_confirmation',reason:body.reason});
    for(const item of body.items){
      const mat=(await txQuery<any>(tx,`SELECT standard_price FROM app.materials WHERE id=@id`,{id:item.materialId})).recordset[0];
      if(!mat)fail(400,'Nguyên vật liệu không tồn tại');
      await txQuery(tx,`INSERT INTO app.export_items(slip_id,material_id,requested_quantity,unit_cost) VALUES(@slip,@material,@qty,@cost)`,
        {slip:slipId,material:item.materialId,qty:item.requestedQuantity,cost:mat.standard_price});
    }
    if(requiresApproval)await approval(tx,req,'export_transfer','approve',slipId,body.branchId,{},body.reason);
    await audit(tx,req,'create','export',slipId,null,body);
  });res.status(201).json({id:slipId,code:slipCode,status:requiresApproval?'pending_approval':'pending_confirmation'});
}));
r.patch('/exports/:id',manager,handler(async(req,res)=>{
  const body=parse(exportSchema,req.body),existing=await slip('export',req.params.id);
  if(!existing)fail(404,'Không tìm thấy phiếu xuất');branch(req,existing.branch_id);
  if(body.branchId!==existing.branch_id || body.type!==existing.type || (body.targetBranchId||null)!==(existing.target_branch_id||null))
    fail(409,'Không thể đổi loại phiếu hoặc chi nhánh sau khi tạo');
  if(!['pending_approval','pending_confirmation'].includes(existing.status))fail(409,'Phiếu không còn được sửa');
  await transaction(async tx=>{
    await txQuery(tx,`UPDATE app.export_slips SET type=@type,target_branch_id=@target,reason=@reason,updated_at=CURRENT_TIMESTAMP WHERE id=@id`,
      {id:req.params.id,type:body.type,target:body.targetBranchId||null,reason:body.reason});
    await txQuery(tx,`DELETE FROM app.export_items WHERE slip_id=@id`,{id:req.params.id});
    for(const item of body.items){
      const mat=(await txQuery<any>(tx,`SELECT standard_price FROM app.materials WHERE id=@id`,{id:item.materialId})).recordset[0];
      if(!mat)fail(400,'Nguyên vật liệu không tồn tại');
      await txQuery(tx,`INSERT INTO app.export_items(slip_id,material_id,requested_quantity,unit_cost) VALUES(@slip,@material,@qty,@cost)`,
        {slip:req.params.id,material:item.materialId,qty:item.requestedQuantity,cost:mat.standard_price});
    }
    await audit(tx,req,'update','export',req.params.id,existing,body);
  });res.json({id:req.params.id,status:existing.status});
}));
r.post('/exports/:id/confirm',stockActor,handler(async(req,res)=>{
  const body=parse(z.object({items:z.array(z.object({materialId:z.string(),actualQuantity:pos})).min(1),
    incidentStatus:z.enum(['normal','incident']).default('normal'),incidentReason:z.string().trim().optional()}),req.body);
  if(body.incidentStatus==='incident'&&!body.incidentReason)fail(400,'Cần nhập lý do sự cố');
  if(new Set(body.items.map(i=>i.materialId)).size!==body.items.length)fail(400,'Nguyên vật liệu bị trùng');
  await transaction(async tx=>{
    const row=(await txQuery<any>(tx,`SELECT * FROM app.export_slips WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!row)fail(404,'Không tìm thấy phiếu xuất');branch(req,row.branch_id);
    if(row.status!=='pending_confirmation')fail(409,'Phiếu chưa được duyệt hoặc đã xử lý');
    const expected=(await txQuery<any>(tx,`SELECT material_id,requested_quantity FROM app.export_items WHERE slip_id=@id`,{id:req.params.id})).recordset;
    if(expected.length!==body.items.length||body.items.some(i=>!expected.some((x:any)=>x.material_id===i.materialId)))fail(400,'Cần xác nhận đủ các nguyên vật liệu trong phiếu');
    for(const item of body.items){
      if(row.type==='cap_quay'){
        const stock=(await txQuery<any>(tx,`SELECT quantity FROM app.branch_stock WHERE branch_id=@branch AND material_id=@material`,
          {branch:row.branch_id,material:item.materialId})).recordset[0];
        if(item.actualQuantity>Number(stock?.quantity||0))fail(409,'Số lượng cấp quầy vượt tồn chi nhánh');
        await movement(tx,req,row.branch_id,item.materialId,0,'internal_transfer',req.params.id,`${req.params.id}:${item.materialId}`);
      }
      else await movement(tx,req,row.branch_id,item.materialId,-item.actualQuantity,'export',req.params.id,`${req.params.id}:${item.materialId}`);
      if(row.type==='chuyen_kho')await movement(tx,req,row.target_branch_id,item.materialId,item.actualQuantity,'transfer_in',req.params.id,`${req.params.id}:${item.materialId}:in`);
      await txQuery(tx,`UPDATE app.export_items SET actual_quantity=@qty WHERE slip_id=@slip AND material_id=@material`,
        {qty:item.actualQuantity,slip:req.params.id,material:item.materialId});
    }
    await txQuery(tx,`UPDATE app.export_slips SET status='completed',incident_status=@incidentStatus,incident_reason=@incidentReason,
      updated_at=CURRENT_TIMESTAMP WHERE id=@id`,{id:req.params.id,incidentStatus:body.incidentStatus,incidentReason:body.incidentReason||null});
    await audit(tx,req,'confirm','export',req.params.id,null,body);
  });res.json({status:'completed'});
}));
r.post('/exports/:id/cancel',manager,handler(async(req,res)=>{
  const {reason}=parse(z.object({reason:z.string().trim().min(1)}),req.body);
  await transaction(async tx=>{
    const row=(await txQuery<any>(tx,`SELECT * FROM app.export_slips WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!row)fail(404,'Không tìm thấy phiếu xuất');branch(req,row.branch_id);
    if(!['pending_approval','pending_confirmation'].includes(row.status))fail(409,'Phiếu không còn được hủy');
    await txQuery(tx,`UPDATE app.export_slips SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=@id`,{id:req.params.id});
    await audit(tx,req,'cancel','export',req.params.id,row,null,reason);
  });res.json({status:'cancelled'});
}));

r.get('/stocktakes',handler(async(req,res)=>{
  const rows=await query<any>(`SELECT id,code,branch_id AS branchId,creator_id AS creatorId,status,note,created_at AS createdAt,completed_at AS completedAt
    FROM app.stocktakes ORDER BY created_at DESC`);
  res.json(actor(req).role==='chucuahang'?rows:rows.filter(x=>actor(req).branchIds.includes(x.branchId)));
}));
r.get('/stocktakes/:id',handler(async(req,res)=>{
  const row=await one<any>('SELECT * FROM app.stocktakes WHERE id=@id',{id:req.params.id});if(!row)fail(404,'Không tìm thấy phiếu kiểm kê');branch(req,row.branch_id);
  const items=await query<any>(`SELECT i.material_id AS materialId,m.name AS materialName,m.unit,i.system_quantity AS systemStock,
    i.actual_quantity AS actualStock,i.actual_quantity-i.system_quantity AS difference,i.difference_reason AS differenceReason,i.remedy
    FROM app.stocktake_items i JOIN app.materials m ON m.id=i.material_id WHERE i.stocktake_id=@id`,{id:req.params.id});
  res.json({...row,items});
}));
r.post('/stocktakes',stockActor,handler(async(req,res)=>{
  const body=parse(z.object({branchId:z.string(),period:z.string().optional(),note:z.string().optional()}),req.body);branch(req,body.branchId);
  if(body.period)periodRange(body.period);
  const stocktakeId=id();
  let stocktakeCode='';
  await transaction(async tx=>{
    stocktakeCode=await code(tx,'PKK');
    await txQuery(tx,`INSERT INTO app.stocktakes(id,code,branch_id,creator_id,status,period,note) VALUES(@id,@code,@branch,@creator,'draft',@period,@note)`,
      {id:stocktakeId,code:stocktakeCode,branch:body.branchId,creator:actor(req).id,period:body.period||null,note:body.note||null});
    await txQuery(tx,`INSERT INTO app.stocktake_items(stocktake_id,material_id,system_quantity)
      SELECT @id,m.id,COALESCE(s.quantity,0) FROM app.materials m LEFT JOIN app.branch_stock s
      ON s.material_id=m.id AND s.branch_id=@branch WHERE m.status='active'`,{id:stocktakeId,branch:body.branchId});
    await audit(tx,req,'create','stocktake',stocktakeId,null,body);
  });res.status(201).json({id:stocktakeId,code:stocktakeCode,status:'draft'});
}));
r.post('/stocktakes/:id/cancel',stockActor,handler(async(req,res)=>{
  await transaction(async tx=>{
    const row=(await txQuery<any>(tx,`SELECT id,branch_id,creator_id,status FROM app.stocktakes WHERE id=@id FOR UPDATE`,{id:req.params.id})).recordset[0];
    if(!row)fail(404,'Không tìm thấy phiếu kiểm kê');
    branch(req,row.branch_id);
    if(row.status!=='draft')fail(409,'Chỉ hủy được phiếu kiểm kê nháp');
    if(row.creator_id!==actor(req).id)fail(403,'Chỉ người tạo mới được hủy phiếu nháp');
    await txQuery(tx,`DELETE FROM app.stocktake_items WHERE stocktake_id=@id`,{id:req.params.id});
    await txQuery(tx,`DELETE FROM app.stocktakes WHERE id=@id`,{id:req.params.id});
    await audit(tx,req,'cancel','stocktake',req.params.id,row);
  });
  res.status(204).end();
}));
const countSchema=z.object({items:z.array(z.object({materialId:z.string(),actualStock:nonneg})).min(1),note:z.string().optional(),period:z.string().optional()});
r.patch('/stocktakes/:id',stockActor,handler(async(req,res)=>{
  const body=parse(countSchema,req.body);
  if(body.period)periodRange(body.period);
  await transaction(async tx=>{
    const row=(await txQuery<any>(tx,`SELECT * FROM app.stocktakes WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!row)fail(404,'Không tìm thấy phiếu kiểm kê');branch(req,row.branch_id);
    if(row.status!=='draft')fail(409,'Phiếu đã hoàn thành');
    for(const item of body.items){
      const result=await txQuery(tx,`UPDATE app.stocktake_items SET actual_quantity=@qty
        WHERE stocktake_id=@id AND material_id=@material`,{id:req.params.id,material:item.materialId,qty:item.actualStock});
      if(!result.rowsAffected[0])fail(400,'Nguyên vật liệu không thuộc phiếu');
    }
    if(body.note!==undefined)await txQuery(tx,`UPDATE app.stocktakes SET note=@note WHERE id=@id`,{id:req.params.id,note:body.note});
    if(body.period!==undefined)await txQuery(tx,`UPDATE app.stocktakes SET period=@period WHERE id=@id`,{id:req.params.id,period:body.period});
    await audit(tx,req,'count','stocktake',req.params.id,null,body);
  });res.json({status:'draft'});
}));
r.post('/stocktakes/:id/complete',stockActor,handler(async(req,res)=>{
  await transaction(async tx=>{
    const row=(await txQuery<any>(tx,`SELECT * FROM app.stocktakes WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!row)fail(404,'Không tìm thấy phiếu kiểm kê');branch(req,row.branch_id);
    if(row.status!=='draft')fail(409,'Phiếu đã hoàn thành');
    const missing=(await txQuery<any>(tx,`SELECT COUNT(*) AS n FROM app.stocktake_items WHERE stocktake_id=@id AND actual_quantity IS NULL`,{id:req.params.id})).recordset[0];
    if(Number(missing.n)>0)fail(400,'Cần nhập đầy đủ số lượng kiểm đếm');
    await txQuery(tx,`UPDATE app.stocktakes SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=@id`,{id:req.params.id});
    await audit(tx,req,'complete','stocktake',req.params.id);
  });res.json({status:'completed'});
}));
r.patch('/stocktakes/:id/handling',manager,handler(async(req,res)=>{
  const body=parse(z.object({items:z.array(z.object({materialId:z.string(),reason:z.string().trim().min(1),remedy:z.string().trim().min(1)})).min(1)}),req.body);
  if(new Set(body.items.map(i=>i.materialId)).size!==body.items.length)fail(400,'Nguyên vật liệu bị trùng');
  await transaction(async tx=>{
    const row=(await txQuery<any>(tx,`SELECT * FROM app.stocktakes WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!row)fail(404,'Không tìm thấy phiếu kiểm kê');branch(req,row.branch_id);
    if(row.status!=='completed')fail(409,'Phiếu chưa hoàn tất hoặc đã điều chỉnh');
    for(const item of body.items){
      const result=await txQuery(tx,`UPDATE app.stocktake_items SET difference_reason=@reason,remedy=@remedy
        WHERE stocktake_id=@id AND material_id=@material AND actual_quantity<>system_quantity`,
        {id:req.params.id,material:item.materialId,reason:item.reason,remedy:item.remedy});
      if(!result.rowsAffected[0])fail(400,'Dòng nguyên vật liệu không có chênh lệch');
    }
    await audit(tx,req,'handle_difference','stocktake',req.params.id,null,body);
  });res.json({status:'completed'});
}));
r.post('/stocktakes/:id/propose-adjustment',manager,handler(async(req,res)=>{
  const {reason}=parse(z.object({reason:z.string().trim().min(1)}),req.body);
  const approvalId=await transaction(async tx=>{
    const row=(await txQuery<any>(tx,`SELECT * FROM app.stocktakes WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!row)fail(404,'Không tìm thấy phiếu kiểm kê');branch(req,row.branch_id);
    if(row.status!=='completed')fail(409,'Phiếu chưa hoàn tất hoặc đã điều chỉnh');
    const pending=(await txQuery<any>(tx,`SELECT id FROM app.approval_requests WHERE type='stock_adjustment' AND reference_id=@id AND status='pending'`,{id:req.params.id})).recordset;
    if(pending.length)fail(409,'Đã có đề xuất chờ duyệt');
    const differences=(await txQuery<any>(tx,`SELECT COUNT(*) AS n FROM app.stocktake_items WHERE stocktake_id=@id AND actual_quantity<>system_quantity`,{id:req.params.id})).recordset[0];
    if(!Number(differences.n))fail(409,'Không có chênh lệch cần điều chỉnh');
    const untreated=(await txQuery<any>(tx,`SELECT COUNT(*) AS n FROM app.stocktake_items WHERE stocktake_id=@id
      AND actual_quantity<>system_quantity AND (NULLIF(TRIM(difference_reason),'') IS NULL OR NULLIF(TRIM(remedy),'') IS NULL)`,{id:req.params.id})).recordset[0];
    if(Number(untreated.n))fail(409,'Cần nhập nguyên nhân và biện pháp cho mọi chênh lệch');
    const approvalId=await approval(tx,req,'stock_adjustment','apply',req.params.id,row.branch_id,{},reason);
    await audit(tx,req,'propose_adjustment','stocktake',req.params.id,null,null,reason);return approvalId;
  });res.status(202).json({approvalId,status:'pending'});
}));

r.get('/approvals',roles('chucuahang','quanly','ketoan'),handler(async(req,res)=>{
  const rows=await query<any>(`SELECT a.id,a.type,a.action,a.reference_id AS referenceId,a.branch_id AS branchId,
    a.requester_id AS requesterId,u.name AS requesterName,a.payload,a.reason,a.status,a.created_at AS requestedAt,
    a.reviewed_by AS reviewedBy,a.reviewed_at AS reviewedAt,a.review_note AS reviewNote
    FROM app.approval_requests a JOIN app.users u ON u.id=a.requester_id ORDER BY a.created_at DESC`);
  res.json((actor(req).role==='chucuahang'?rows:rows.filter(x=>!x.branchId||actor(req).branchIds.includes(x.branchId)))
    .map(x=>({...x,details:x.payload?JSON.parse(x.payload):null,payload:undefined})));
}));
r.get('/approvals/:id',roles('chucuahang','quanly','ketoan'),handler(async(req,res)=>{
  const row=await one<any>('SELECT * FROM app.approval_requests WHERE id=@id',{id:req.params.id});if(!row)fail(404,'Không tìm thấy yêu cầu');
  if(row.branch_id)branch(req,row.branch_id);res.json({...row,payload:row.payload?JSON.parse(row.payload):null});
}));
r.post('/approvals/:id/approve',owner,handler(async(req,res)=>{
  const note=parse(z.object({note:z.string().optional()}),req.body||{}).note;
  await transaction(async tx=>{
    const appr=(await txQuery<any>(tx,`SELECT * FROM app.approval_requests WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!appr)fail(404,'Không tìm thấy yêu cầu');if(appr.status!=='pending')fail(409,'Yêu cầu đã được xử lý');
    const payload=appr.payload?JSON.parse(appr.payload):{};
    if(appr.type==='import_plan') {
      const result=await txQuery(tx,`UPDATE app.import_slips SET status='approved',updated_at=CURRENT_TIMESTAMP WHERE id=@id AND status='pending_approval'`,{id:appr.reference_id});
      if(!result.rowsAffected[0])fail(409,'Trạng thái phiếu nhập đã thay đổi');
    } else if(appr.type==='export_transfer') {
      const result=await txQuery(tx,`UPDATE app.export_slips SET status='pending_confirmation',updated_at=CURRENT_TIMESTAMP WHERE id=@id AND status='pending_approval'`,{id:appr.reference_id});
      if(!result.rowsAffected[0])fail(409,'Trạng thái phiếu xuất đã thay đổi');
    } else if(appr.type==='threshold') {
      await txQuery(tx,`INSERT INTO app.branch_thresholds(branch_id,material_id,minimum_quantity) VALUES(@branch,@material,@qty)
        ON CONFLICT(branch_id,material_id) DO UPDATE SET minimum_quantity=EXCLUDED.minimum_quantity`,
        {branch:appr.branch_id,material:appr.reference_id,qty:payload.minimumQuantity});
    } else if(appr.type==='recipe' && appr.action==='deactivate') {
      const result=await txQuery(tx,`UPDATE app.recipes SET status='inactive',updated_at=CURRENT_TIMESTAMP WHERE id=@id AND status='active'`,{id:appr.reference_id});
      if(!result.rowsAffected[0])fail(409,'Trạng thái công thức đã thay đổi');
    } else if(appr.type==='recipe') {
      const version=await txQuery<any>(tx,`SELECT * FROM app.recipe_versions WHERE id=@id AND recipe_id=@recipe AND status='pending'`,{id:payload.versionId,recipe:appr.reference_id});
      if(!version.recordset.length)fail(409,'Phiên bản công thức không còn chờ duyệt');
      await txQuery(tx,`UPDATE app.recipe_versions SET status='superseded' WHERE recipe_id=@recipe AND status='active'`,{recipe:appr.reference_id});
      await txQuery(tx,`UPDATE app.recipe_versions SET status='active',approved_by=@user,approved_at=CURRENT_TIMESTAMP WHERE id=@id`,{id:payload.versionId,user:actor(req).id});
      await txQuery(tx,`UPDATE app.recipes SET current_version_id=@version,status='active',
        name=COALESCE(@name,name),category=COALESCE(@category,category),sale_price=COALESCE(@price,sale_price),
        note=COALESCE(@note,note),updated_at=CURRENT_TIMESTAMP WHERE id=@recipe`,
        {version:payload.versionId,recipe:appr.reference_id,name:payload.name,category:payload.category,price:payload.price,note:payload.note});
    } else if(appr.type==='material') {
      if(appr.action==='create')await txQuery(tx,`UPDATE app.materials SET status='active' WHERE id=@id AND status='pending'`,{id:appr.reference_id});
      else if(appr.action==='deactivate') {
        const stock=(await txQuery<any>(tx,`SELECT COALESCE(SUM(quantity),0) AS total FROM app.branch_stock WHERE material_id=@id`,{id:appr.reference_id})).recordset[0];
        if(Number(stock.total)>0)fail(409,'Nguyên vật liệu đã phát sinh tồn kho');
        const used=(await txQuery<any>(tx,`SELECT 1 FROM app.recipe_ingredients i JOIN app.recipes r ON r.current_version_id=i.version_id
          WHERE i.material_id=@id AND r.status='active' LIMIT 1`,{id:appr.reference_id})).recordset[0];
        if(used)fail(409,'Nguyên vật liệu đang được dùng trong công thức có hiệu lực');
        await txQuery(tx,`UPDATE app.materials SET status='inactive',deactivation_reason=@reason WHERE id=@id`,{id:appr.reference_id,reason:appr.reason});
      } else if(appr.action==='update')await txQuery(tx,`UPDATE app.materials SET name=COALESCE(@name,name),category=COALESCE(@category,category),
        unit=COALESCE(@unit,unit),standard_price=COALESCE(@price,standard_price),allowed_loss_percent=COALESCE(@loss,allowed_loss_percent),
        allowed_loss_quantity=COALESCE(@lossQuantity,allowed_loss_quantity),
        supplier_id=COALESCE(@supplier,supplier_id),description=COALESCE(@description,description) WHERE id=@id`,
        {id:appr.reference_id,name:payload.name,category:payload.category,unit:payload.unit,price:payload.standardPrice,loss:payload.allowedLossPercent,lossQuantity:payload.allowedLossQuantity,
         supplier:payload.supplierId,description:payload.description});
    } else if(appr.type==='stock_adjustment') {
      const st=(await txQuery<any>(tx,`SELECT * FROM app.stocktakes WHERE id=@id`,{id:appr.reference_id})).recordset[0];
      if(!st||st.status!=='completed')fail(409,'Phiếu kiểm kê không còn hợp lệ');
      const items=(await txQuery<any>(tx,`SELECT material_id,system_quantity,actual_quantity FROM app.stocktake_items WHERE stocktake_id=@id`,{id:st.id})).recordset;
      for(const item of items) {
        const delta=Number(item.actual_quantity)-Number(item.system_quantity);
        if(delta!==0)await movement(tx,req,st.branch_id,item.material_id,delta,'stock_adjustment',st.id,`${st.id}:${item.material_id}`);
      }
      await txQuery(tx,`UPDATE app.stocktakes SET status='adjusted' WHERE id=@id`,{id:st.id});
    } else fail(400,'Loại phê duyệt chưa hỗ trợ');
    await txQuery(tx,`UPDATE app.approval_requests SET status='approved',reviewed_by=@user,reviewed_at=CURRENT_TIMESTAMP,review_note=@note WHERE id=@id`,
      {id:appr.id,user:actor(req).id,note:note||null});
    await audit(tx,req,'approve','approval',appr.id,appr,{status:'approved'},note);
  });res.json({status:'approved'});
}));
r.post('/approvals/:id/reject',owner,handler(async(req,res)=>{
  const {reason}=parse(z.object({reason:z.string().trim().min(1)}),req.body);
  await transaction(async tx=>{
    const appr=(await txQuery<any>(tx,`SELECT * FROM app.approval_requests WHERE id=@id`,{id:req.params.id})).recordset[0];
    if(!appr)fail(404,'Không tìm thấy yêu cầu');if(appr.status!=='pending')fail(409,'Yêu cầu đã được xử lý');
    if(appr.type==='import_plan')await txQuery(tx,`UPDATE app.import_slips SET status='rejected',rejection_reason=@reason WHERE id=@id AND status='pending_approval'`,{id:appr.reference_id,reason});
    if(appr.type==='export_transfer')await txQuery(tx,`UPDATE app.export_slips SET status='cancelled' WHERE id=@id AND status='pending_approval'`,{id:appr.reference_id});
    if(appr.type==='recipe'){
      const payload=JSON.parse(appr.payload||'{}');
      await txQuery(tx,`UPDATE app.recipe_versions SET status='rejected' WHERE id=@id AND status='pending'`,{id:payload.versionId});
      if(appr.action==='create')await txQuery(tx,`UPDATE app.recipes SET status='rejected' WHERE id=@id`,{id:appr.reference_id});
    }
    if(appr.type==='material'&&appr.action==='create')await txQuery(tx,`UPDATE app.materials SET status='inactive',deactivation_reason=@reason WHERE id=@id`,{id:appr.reference_id,reason});
    await txQuery(tx,`UPDATE app.approval_requests SET status='rejected',reviewed_by=@user,reviewed_at=CURRENT_TIMESTAMP,review_note=@reason WHERE id=@id`,
      {id:appr.id,user:actor(req).id,reason});
    await audit(tx,req,'reject','approval',appr.id,appr,{status:'rejected'},reason);
  });res.json({status:'rejected'});
}));

function periodRange(period:string) {
  const match=/^(\d{4})-(0[1-9]|1[0-2]|Q[1-4])$/.exec(period);
  if(!match)return fail(400,'Kỳ phải có dạng YYYY-MM hoặc YYYY-Q1..Q4');
  const year=Number(match[1]),month=match[2].startsWith('Q')?(Number(match[2][1])-1)*3+1:Number(match[2]);
  const length=match[2].startsWith('Q')?3:1;
  const start=`${year}-${String(month).padStart(2,'0')}-01`;
  const endDate=new Date(Date.UTC(year,month-1+length,0));
  const end=endDate.toISOString().slice(0,10);
  return {start,end};
}
function overlaps(a:{start:string;end:string},b:{start:string;end:string}) {return a.start<=b.end&&b.start<=a.end;}
const salesSchema=z.object({branchId:z.string(),period:z.string().trim().min(1),fileName:z.string().optional(),overwrite:z.boolean().default(false),
  items:z.array(z.object({recipeId:z.string().trim().min(1),name:z.string().optional(),quantity:z.number().int().nonnegative(),unitPrice:nonneg.optional()})).min(1)});
async function salesPreview(body:z.infer<typeof salesSchema>) {
  periodRange(body.period);
  const output=[] as any[],warnings=[] as string[],totals=new Map<string,number>(),unmatchedItems=[] as any[];
  if(new Set(body.items.map(i=>i.recipeId.toLowerCase())).size!==body.items.length)fail(400,'Mã món trong file bị trùng');
  for(const item of body.items){
    const found=await one<{id:string}>(`SELECT id FROM app.recipes WHERE (id=@key OR LOWER(code)=LOWER(@key) OR LOWER(name)=LOWER(@name)) AND status='active' LIMIT 1`,
      {key:item.recipeId,name:item.name||item.recipeId});
    const rec=found?await recipeDetail(found.id):undefined;
    if(!rec||!rec.currentVersionId){
      unmatchedItems.push({recipeId:item.recipeId,name:item.name||null,quantity:item.quantity});
      warnings.push(`Món ${item.recipeId} chưa có công thức có hiệu lực`);
      continue;
    }
    const price=item.unitPrice??rec.price;
    output.push({recipeId:rec.id,recipeCode:rec.code,recipeName:rec.name,quantity:item.quantity,unitPrice:price,subtotal:price*item.quantity,recipeVersionId:rec.currentVersionId});
    for(const ing of rec.ingredients)totals.set(ing.materialId,(totals.get(ing.materialId)||0)+ing.quantity*item.quantity);
  }
  if(new Set(output.map(x=>x.recipeId)).size!==output.length)fail(400,'Nhiều dòng ánh xạ đến cùng một món; cần gộp số lượng');
  return {items:output,unmatchedItems,estimatedRevenue:output.reduce((n,x)=>n+x.subtotal,0),theoreticalConsumption:[...totals].map(([materialId,quantity])=>({materialId,quantity})),warnings};
}
r.post('/sales-imports/preview',salesActor,handler(async(req,res)=>{
  const body=parse(salesSchema,req.body);branch(req,body.branchId);res.json(await salesPreview(body));
}));
r.get('/sales-imports',salesActor,handler(async(req,res)=>{
  const rows=await query<any>(`SELECT id,branch_id AS branchId,period,file_name AS fileName,imported_at AS importedAt FROM app.sales_imports ORDER BY imported_at DESC`);
  res.json(actor(req).role==='chucuahang'?rows:rows.filter(x=>actor(req).branchIds.includes(x.branchId)));
}));
r.get('/sales-imports/:id',salesActor,handler(async(req,res)=>{
  const row=await one<any>(`SELECT id,branch_id AS branchId,period,file_name AS fileName,imported_by AS importedBy,imported_at AS importedAt
    FROM app.sales_imports WHERE id=@id`,{id:req.params.id});
  if(!row)fail(404,'Không tìm thấy dữ liệu bán hàng');branch(req,row.branchId);
  const items=await query<any>(`SELECT i.recipe_id AS recipeId,r.code AS recipeCode,r.name AS recipeName,
    i.recipe_version_id AS recipeVersionId,i.quantity,i.unit_price AS unitPrice
    FROM app.sales_items i JOIN app.recipes r ON r.id=i.recipe_id WHERE i.import_id=@id`,{id:row.id});
  const unmatchedItems=await query<any>(`SELECT item_code AS recipeId,item_name AS name,quantity FROM app.sales_unmatched_items WHERE import_id=@id`,{id:row.id});
  res.json({...row,items:items.map(i=>({...i,quantity:Number(i.quantity),unitPrice:Number(i.unitPrice),subtotal:Number(i.quantity)*Number(i.unitPrice)})),unmatchedItems});
}));
r.post('/sales-imports',salesActor,handler(async(req,res)=>{
  const body=parse(salesSchema,req.body);branch(req,body.branchId);
  const preview=await salesPreview(body);
  const range=periodRange(body.period);
  const result=await transaction(async tx=>{
    const existing=(await txQuery<any>(tx,`SELECT id,period FROM app.sales_imports WHERE branch_id=@branch`,{branch:body.branchId})).recordset;
    const old=existing.filter(x=>{
      try {return overlaps(periodRange(x.period),range);} catch {return x.period===body.period;}
    });
    if(old.length&&!body.overwrite)fail(409,'Kỳ bán hàng đã tồn tại hoặc chồng lấn; cần xác nhận ghi đè');
    const replaced=[] as any[];
    for(const prior of old){
      const lines=(await txQuery<any>(tx,`SELECT recipe_id AS recipeId,recipe_version_id AS recipeVersionId,quantity,unit_price AS unitPrice
        FROM app.sales_items WHERE import_id=@id`,{id:prior.id})).recordset;
      const unmatched=(await txQuery<any>(tx,`SELECT item_code AS recipeId,item_name AS name,quantity
        FROM app.sales_unmatched_items WHERE import_id=@id`,{id:prior.id})).recordset;
      replaced.push({...prior,items:lines,unmatchedItems:unmatched});
      await txQuery(tx,`DELETE FROM app.sales_unmatched_items WHERE import_id=@id`,{id:prior.id});
      await txQuery(tx,`DELETE FROM app.sales_items WHERE import_id=@id`,{id:prior.id});
      await txQuery(tx,`DELETE FROM app.sales_imports WHERE id=@id`,{id:prior.id});
    }
    const importId=await code(tx,'BH');
    await txQuery(tx,`INSERT INTO app.sales_imports(id,branch_id,period,period_start,period_end,imported_by,file_name)
      VALUES(@id,@branch,@period,@start,@end,@user,@file)`,
      {id:importId,branch:body.branchId,period:body.period,start:range.start,end:range.end,user:actor(req).id,file:body.fileName||null});
    for(const item of preview.items)await txQuery(tx,`INSERT INTO app.sales_items(import_id,recipe_id,recipe_version_id,quantity,unit_price)
      VALUES(@id,@recipe,@version,@qty,@price)`,{id:importId,recipe:item.recipeId,version:item.recipeVersionId,qty:item.quantity,price:item.unitPrice});
    for(const item of preview.unmatchedItems)await txQuery(tx,`INSERT INTO app.sales_unmatched_items(import_id,item_code,item_name,quantity)
      VALUES(@id,@code,@name,@qty)`,{id:importId,code:item.recipeId,name:item.name,qty:item.quantity});
    await audit(tx,req,old.length?'overwrite':'import','sales_import',importId,replaced,body);
    return {id:importId,overwritten:old.length>0,replacedImportIds:old.map(x=>x.id)};
  });res.status(result.overwritten?200:201).json({...result,warnings:preview.warnings,unmatchedItems:preview.unmatchedItems});
}));

r.get('/reports/inventory',roles('chucuahang','quanly','ketoan'),handler(async(req,res)=>{
  const branchId=String(req.query.branchId||'');if(!branchId)fail(400,'Cần chọn chi nhánh');branch(req,branchId);
  const at=req.query.at?new Date(String(req.query.at)):null;if(at&&Number.isNaN(at.getTime()))fail(400,'Ngày không hợp lệ');
  const from=req.query.from?new Date(String(req.query.from)):null;
  if(from&&Number.isNaN(from.getTime()))fail(400,'Ngày bắt đầu không hợp lệ');
  if(from&&(!at||from>at))fail(400,'Cần chọn thời điểm kết thúc sau ngày bắt đầu');
  const rows=at?await query<any>(`SELECT m.id AS materialId,m.code,m.name,m.category,m.unit,m.standard_price AS standardPrice,
    COALESCE(SUM(CASE WHEN v.created_at<=@at THEN v.delta ELSE 0 END),0) AS quantity,
    COALESCE(SUM(CASE WHEN v.created_at<@from THEN v.delta ELSE 0 END),0) AS opening,
    COALESCE(SUM(CASE WHEN v.created_at>=@from AND v.created_at<=@at AND v.delta>0 THEN v.delta ELSE 0 END),0) AS inbound,
    COALESCE(SUM(CASE WHEN v.created_at>=@from AND v.created_at<=@at AND v.delta<0 THEN -v.delta ELSE 0 END),0) AS outbound,
    COALESCE(SUM(CASE WHEN v.created_at>=@from AND v.created_at<=@at AND v.source_type='stock_adjustment' THEN v.delta ELSE 0 END),0) AS adjustment,
    COALESCE(t.minimum_quantity,0) AS minimumQuantity FROM app.materials m
    LEFT JOIN app.stock_movements v ON v.material_id=m.id AND v.branch_id=@branch
    LEFT JOIN app.branch_thresholds t ON t.material_id=m.id AND t.branch_id=@branch
    GROUP BY m.id,m.code,m.name,m.category,m.unit,m.standard_price,t.minimum_quantity ORDER BY m.name`,{branch:branchId,at,from:from||new Date(0)}):
    await query<any>(`SELECT m.id AS materialId,m.code,m.name,m.category,m.unit,m.standard_price AS standardPrice,
    COALESCE(s.quantity,0) AS quantity,COALESCE(t.minimum_quantity,0) AS minimumQuantity FROM app.materials m
    LEFT JOIN app.branch_stock s ON s.material_id=m.id AND s.branch_id=@branch
    LEFT JOIN app.branch_thresholds t ON t.material_id=m.id AND t.branch_id=@branch ORDER BY m.name`,{branch:branchId});
  res.json({branchId,at:at?.toISOString()||null,items:rows.map(x=>({...x,quantity:Number(x.quantity),
    opening:at?Number(x.opening):Number(x.quantity),inbound:Number(x.inbound||0),outbound:Number(x.outbound||0),adjustment:Number(x.adjustment||0),minimumQuantity:Number(x.minimumQuantity),
    standardPrice:Number(x.standardPrice),value:Number(x.quantity)*Number(x.standardPrice),lowStock:Number(x.quantity)<=Number(x.minimumQuantity)}))});
}));
r.get(['/reports/variance','/reports/loss'],roles('chucuahang','quanly'),handler(async(req,res)=>{
  const branchId=String(req.query.branchId||''),period=String(req.query.period||''),stocktakeId=String(req.query.stocktakeId||'');
  if(!branchId||!period)fail(400,'Cần chọn chi nhánh và kỳ');branch(req,branchId);
  periodRange(period);
  const sale=await one<any>(`SELECT id,imported_at AS importedAt FROM app.sales_imports WHERE branch_id=@branch AND period=@period`,{branch:branchId,period});
  const stocktake=await one<any>(`SELECT id,completed_at AS completedAt FROM app.stocktakes WHERE branch_id=@branch AND period=@period
    AND status IN ('completed','adjusted') AND (@stocktakeId='' OR id=@stocktakeId) ORDER BY completed_at DESC LIMIT 1`,{branch:branchId,period,stocktakeId});
  if(!sale||!stocktake)return res.status(422).json({error:'Thiếu dữ liệu để đối soát',missing:{sales:!sale,stocktake:!stocktake}});
  const counted=await query<any>(`SELECT i.material_id AS materialId,m.code,m.name,m.unit,m.standard_price AS standardPrice,
    i.system_quantity AS systemStock,i.actual_quantity AS actualStock,i.actual_quantity-i.system_quantity AS stockVariance,
    i.difference_reason AS differenceReason,i.remedy,m.allowed_loss_quantity AS allowedLossQuantity,m.allowed_loss_percent AS allowedLossPercent
    FROM app.stocktake_items i JOIN app.materials m ON m.id=i.material_id WHERE i.stocktake_id=@id`,{id:stocktake.id});
  const usage=await query<any>(`SELECT ri.material_id AS materialId,SUM(si.quantity*ri.quantity) AS theoreticalConsumption
    FROM app.sales_items si JOIN app.recipe_ingredients ri ON ri.version_id=si.recipe_version_id
    WHERE si.import_id=@id GROUP BY ri.material_id`,{id:sale.id});
  const usageMap=new Map(usage.map(x=>[x.materialId,Number(x.theoreticalConsumption)]));
  res.json({branchId,period,salesImportId:sale.id,stocktakeId:stocktake.id,
    items:counted.map(x=>{
      const systemStock=Number(x.systemStock),actualStock=Number(x.actualStock),theoreticalConsumption=usageMap.get(x.materialId)||0;
      const theoreticalStock=systemStock-theoreticalConsumption,loss=theoreticalStock-actualStock,allowance=Number(x.allowedLossQuantity);
      return {materialId:x.materialId,code:x.code,name:x.name,unit:x.unit,systemStock,actualStock,theoreticalConsumption,theoreticalStock,
        loss,classification:loss<0?'surplus':loss>allowance?'over_limit':'within_limit',allowedLossQuantity:allowance,
        stockVariance:actualStock-systemStock,lossValue:loss*Number(x.standardPrice),differenceReason:x.differenceReason,remedy:x.remedy};
    })});
}));
r.get('/dashboard',handler(async(req,res)=>{
  const branchId=String(req.query.branchId||'');if(branchId)branch(req,branchId);
  const scope=actor(req).role==='chucuahang'?(branchId?[branchId]:null):actor(req).branchIds;
  const inventory=await query<any>(`SELECT s.branch_id AS branchId,s.material_id AS materialId,s.quantity,t.minimum_quantity AS minimumQuantity
    FROM app.branch_stock s LEFT JOIN app.branch_thresholds t ON t.branch_id=s.branch_id AND t.material_id=s.material_id
    JOIN app.materials m ON m.id=s.material_id WHERE m.status='active'`);
  const scoped=(x:any)=>!scope||scope.includes(x.branchId);
  const imports=await query<any>(`SELECT branch_id AS branchId,status FROM app.import_slips WHERE status IN ('pending_approval','approved','receiving','backorder')`);
  const exports=await query<any>(`SELECT branch_id AS branchId,status FROM app.export_slips WHERE status IN ('pending_approval','pending_confirmation')`);
  const stocktakes=await query<any>(`SELECT branch_id AS branchId,status FROM app.stocktakes WHERE status='draft'`);
  const approvals=await query<any>(`SELECT branch_id AS branchId,status FROM app.approval_requests WHERE status='pending'`);
  res.json({lowStock:actor(req).role==='nhanvien'?null:inventory.filter(x=>scoped(x)&&Number(x.quantity)<=Number(x.minimumQuantity||0)).length,
    pendingImports:imports.filter(x=>scoped(x)).length,pendingExports:exports.filter(x=>scoped(x)).length,
    openStocktakes:stocktakes.filter(x=>scoped(x)).length,pendingApprovals:approvals.filter(x=>scoped(x)).length});
}));
r.get('/stock-movements',roles('chucuahang','quanly','ketoan'),handler(async(req,res)=>{
  const branchId=String(req.query.branchId||'');if(!branchId)fail(400,'Cần chọn chi nhánh');branch(req,branchId);
  const rows=await query<any>(`SELECT id,branch_id AS branchId,material_id AS materialId,delta,balance_after AS balanceAfter,
    source_type AS sourceType,source_id AS sourceId,created_at AS createdAt FROM app.stock_movements WHERE branch_id=@branch ORDER BY created_at DESC LIMIT 200`,{branch:branchId});
  res.json(rows);
}));
export default r;
