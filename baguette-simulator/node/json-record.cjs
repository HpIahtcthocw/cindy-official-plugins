'use strict';
const fs=require('node:fs/promises');
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Persistent records may start empty only when absent. Never turn corrupt or
// unreadable data into a successful read that a later update could overwrite.
async function readJsonRecord(file,{initial,validate,code,message}){
 try{
  let text;
  try{text=await fs.readFile(file,'utf8');}
  catch(error){if(error.code==='ENOENT')return initial;throw error;}
  const value=JSON.parse(text);
  if(!isRecord(value)||!validate(value))throw Error('Invalid saved record');
  return value;
 }catch(cause){throw Object.assign(Error(message,{cause}),{code,execution:'not_executed'});}
}
module.exports={readJsonRecord,isRecord};
