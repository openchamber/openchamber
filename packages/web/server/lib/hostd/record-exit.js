// '+' restores root credentials and filesystem write authority, but TemporaryFileSystem
// overlays still hide the installed /opt tree. The root-owned unit carries this fixed
// built-ins-only program so its recorder needs no path through the service's mounts.
export const EXIT_RECORDER_PROGRAM = `
(async()=>{
  const fs=require('node:fs/promises');
  const {randomBytes}=require('node:crypto');
  const [id,result='',code='',status='']=process.argv.slice(1);
  if(!/^[0-9a-f]{12}$/.test(id)||![result,code,status].every(v=>/^[a-zA-Z0-9_-]{0,64}$/.test(v)))throw new Error('Invalid exit record');
  const file='/var/lib/openchamber-hostd/spaces/'+id+'.json';
  const record=JSON.parse(await fs.readFile(file,'utf8'));
  const temporary=file+'.exit-'+randomBytes(6).toString('hex');
  try{await fs.writeFile(temporary,JSON.stringify({...record,lastExit:{result,code,status}})+'\\n',{mode:384,flag:'wx'});await fs.rename(temporary,file);}
  finally{await fs.rm(temporary,{force:true});}
})().catch(()=>{process.exitCode=1;});
`.trim().replaceAll('\n', ' ');
