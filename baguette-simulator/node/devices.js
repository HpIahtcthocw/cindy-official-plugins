'use strict';
(()=>{
 const c=globalThis.baguetteController,z=document.documentElement.lang==='zh-CN';
 const t=z?{
  add:'添加测试设备',edit:'修改设备名称',create:'创建设备',save:'保存名称',
  addHint:'新设备创建后保持关闭。选择它并点击“切换”才会启动；原设备和数据会保留。',
  editHint:'改名会保留 App 和数据。更换机型或系统版本需要新建设备。',
  app:'切换时会尝试打开最近由插件启动的测试 App；不复制登录或 App 数据。',home:'尚无测试 App 记录；切换后显示设备主屏。',
  paused:'运行许可已关闭。请在插件设置中开启后操作。',loading:'正在读取可用机型和系统…',creating:'正在创建，完成后保持关闭…',saving:'正在保存名称…',created:'已创建，设备保持关闭。点击“切换”可开始预览。',saved:'设备名称已保存。',
  preparing:'正在准备切换…',stopping:'正在关闭原设备…',booting:'正在启动所选设备…',installing:'正在安装测试 App…',launching:'正在打开测试 App…',opening:'正在连接新设备画面…',done:'已切换设备。',failed:'切换未完成，正在显示实际设备状态。请核对设备后重试。',error:'未能确认操作结果。请刷新设备列表核对后再试。',empty:'没有兼容的已安装 iOS 版本。请先在 Xcode 安装所需版本。',booted:'运行中',off:'已关闭'
 }:{
  add:'Add test device',edit:'Edit device name',create:'Create device',save:'Save name',
  addHint:'New devices stay shut down. Select one and click Switch to start it. Existing devices and data are kept.',editHint:'Renaming keeps apps and data. A different model or iOS version requires a new device.',
  app:'Switching tries to open the last test app launched by the plugin. Login and app data are not copied.',home:'No test app recorded yet. Switching opens the device home screen.',
  paused:'Simulator operation is off. Enable it in plugin settings first.',loading:'Loading available models and runtimes…',creating:'Creating device; it will stay shut down…',saving:'Saving device name…',created:'Device created and shut down. Click Switch to preview it.',saved:'Device name saved.',
  preparing:'Preparing switch…',stopping:'Shutting down previous device…',booting:'Starting selected device…',installing:'Installing test app…',launching:'Opening test app…',opening:'Connecting new device view…',done:'Device switched.',failed:'Switch did not finish. Showing the actual device state. Check the devices before retrying.',error:'Operation not confirmed. Refresh the device list and check before retrying.',empty:'No compatible iOS runtime is installed. Install the required version in Xcode first.',booted:'Running',off:'Shut down'
 };
 const el=id=>document.getElementById('device-'+id),select=el('select'),dialog=el('dialog'),form=el('form'),model=el('model'),runtime=el('runtime');
 let devices=[],enabled=false,pending=false,mode='add',editing=null,catalog=null,handled=null;
 function lock(){const busy=pending||c.busy;el('add').disabled=!enabled||busy;el('edit').disabled=!enabled||busy||!select.value;el('switch').disabled=!enabled||busy||!select.value||(select.value===c.udid&&devices.find(d=>d.udid===c.udid)?.state==='Booted');select.disabled=busy;}
 function render(list,preferred=select.value){devices=list||[];select.replaceChildren();for(const d of devices){const option=document.createElement('option');option.value=d.udid;option.textContent=d.name+' · '+(d.state==='Booted'?t.booted:d.state==='Shutdown'?t.off:d.state)+' · '+d.udid.slice(-4);select.append(option);}select.value=devices.some(d=>d.udid===preferred)?preferred:c.udid;lock();}
 function progress(value){el('progress').textContent=value;}
 function update(s){
  enabled=s.settings?.enabled===true;render(s.devices);el('context').textContent=!enabled?t.paused:s.currentApp?t.app:t.home;
  const job=s.deviceJob,relevant=job&&(job.sourceUdid===c.udid||job.targetUdid===c.udid);
  if(relevant&&job.state==='running'){pending=true;const label=t[job.phase]||t.preparing;c.switching(true,label);progress(label);lock();return true;}
  if(relevant&&job.id!==handled&&job.state!=='running'){
   handled=job.id;pending=false;c.switching(false);if(job.activeUdid&&job.activeUdid!==c.udid){c.adopt(job.activeUdid);render(s.devices,job.activeUdid);c.check();}
   progress(job.state==='done'?t.done:t.failed+' ('+(job.errorCode||'SWITCH_FAILED')+')');lock();
   // This status response describes the old device. Poll the adopted device next.
   if(s.device?.udid!==c.udid)return true;
  }
  lock();return pending;
 }
 globalThis.baguetteDevices={update};
 select.onchange=lock;
 el('switch').onclick=async()=>{
  if(pending||c.busy||!enabled)return;pending=true;lock();c.switching(true,t.preparing);progress(t.preparing);
  try{const result=await c.api('switch',{targetUdid:select.value});handled=null;progress(t[result.job.phase]||t.preparing);}
  catch(error){pending=false;c.switching(false);progress(t.error+' ('+error.message+')');lock();}
  await c.check();
 };
 const version=v=>String(v||'0').split('.').map(Number).slice(0,3).reduce((a,n,i)=>a+n*Math.pow(65536,2-i),0);
 function options(){
  const chosen=catalog?.deviceTypes.find(d=>d.identifier===model.value),previous=runtime.value;
  runtime.replaceChildren();for(const r of catalog?.runtimes||[]){if(chosen&&Array.isArray(r.supportedDeviceTypes)&&!r.supportedDeviceTypes.includes(chosen.identifier))continue;if(chosen&&(version(r.version)<version(chosen.minRuntimeVersion)||version(r.version)>version(chosen.maxRuntimeVersion||'65535.255.255')))continue;const o=document.createElement('option');o.value=r.identifier;o.textContent=r.name;runtime.append(o);}
  if([...runtime.options].some(o=>o.value===previous))runtime.value=previous;
  else if(runtime.options.length)runtime.selectedIndex=runtime.options.length-1;
  el('save').disabled=!runtime.value;el('error').textContent=runtime.value?'':t.empty;
 }
 model.onchange=()=>{options();if(!el('name').dataset.edited)el('name').value=catalog.deviceTypes.find(d=>d.identifier===model.value)?.name||'';};
 el('name').oninput=()=>{el('name').dataset.edited='true';};
 async function open(kind){
  mode=kind;editing=devices.find(d=>d.udid===select.value);el('dialog-title').textContent=kind==='add'?t.add:t.edit;el('explanation').textContent=kind==='add'?t.addHint:t.editHint;
  el('name').value=kind==='edit'?editing?.name||'':'';delete el('name').dataset.edited;el('error').textContent='';el('options').hidden=kind==='edit';el('new-model').hidden=kind!=='edit';el('save').textContent=kind==='add'?t.create:t.save;el('save').disabled=kind==='add';el('model').required=el('runtime').required=kind==='add';if(!dialog.open)dialog.showModal();
  el('name').disabled=model.disabled=runtime.disabled=kind==='add';
  if(kind==='edit'){el('name').focus();return;}
  el('error').textContent=t.loading;model.replaceChildren();runtime.replaceChildren();
  try{catalog=await c.api('catalog');for(const d of catalog.deviceTypes){const o=document.createElement('option');o.value=d.identifier;o.textContent=d.name;model.append(o);}if(editing?.deviceType)model.value=editing.deviceType;if(!model.value&&model.options.length)model.selectedIndex=0;options();el('name').value=catalog.deviceTypes.find(d=>d.identifier===model.value)?.name||'';el('name').disabled=model.disabled=runtime.disabled=false;el('name').focus();}
  catch(error){el('error').textContent=t.error+' ('+error.message+')';}
 }
 el('add').onclick=()=>open('add');el('edit').onclick=()=>open('edit');el('new-model').onclick=()=>open('add');el('cancel').onclick=()=>{if(!pending)dialog.close();};dialog.addEventListener('cancel',e=>{if(pending)e.preventDefault();});
 form.onsubmit=async event=>{
  event.preventDefault();if(pending||!form.reportValidity())return;pending=true;lock();el('save').disabled=true;el('cancel').disabled=true;el('new-model').disabled=true;el('error').textContent=mode==='add'?t.creating:t.saving;
  try{const result=await c.api(mode==='add'?'create':'rename',{name:el('name').value.trim(),...(mode==='add'?{deviceType:model.value,runtime:runtime.value}:{targetUdid:editing.udid})});render(result.devices,result.created?.udid||editing.udid);dialog.close();progress(mode==='add'?t.created:t.saved);}
  catch(error){el('error').textContent=t.error+' ('+error.message+')';}
  finally{pending=false;el('save').disabled=false;el('cancel').disabled=false;el('new-model').disabled=false;lock();await c.check();}
 };
 c.check();
})();
