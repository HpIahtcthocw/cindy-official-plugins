'use strict';
const text = {
  en:{title:'Your simulators',intro:'See what is running. Stop it whenever you want.',refresh:'Refresh',allow:'Allow simulators to run',allowHint:'Turning this off shuts down all Baguette devices and blocks AI from starting them. Turning it on does not start a device.',idle:'Automatically stop when idle',m15:'After 15 minutes',m30:'After 30 minutes',m60:'After 1 hour',manual:'Manual stop only',idleHint:'Device input and AI operations renew the timer. Watching the screen or refreshing status does not. Shutdown ends apps and their connections; data is kept.',devices:'Devices on this Mac',stopAll:'Stop all devices',stopHint:'Use these controls before disabling the plugin in Cindy. A forced plugin exit may leave devices running. Closing a preview only closes the picture.',viewerTitle:'What opening the viewer enables',viewerHint:'The viewer can control input, rotate, shake, install apps or files, change location, motion, status bar and network conditions, and capture screenshots or recordings. Camera and location access require your interaction. Map search contacts OpenStreetMap. Copy/paste replaces the respective clipboard. Switching shuts down the source, starts the target, and may automatically install the last app bundle, replacing the same bundleId app on the target. Source app data and credentials are not copied. Changes and captures happen when you use those controls.',checking:'Checking devices…',paused:'Simulator operation is off. AI cannot start devices.',running:'Running devices: ',stopped:'All devices are shut down.',empty:'No Baguette devices yet. Ask Cindy to set up a simulator when needed.',boot:'Start device',shutdown:'Shut down',viewer:'Open controls',booted:'Running',off:'Shut down',busyState:'Changing state',working:'Working…',saved:'Saved. Device data is preserved.',failed:'The operation could not be confirmed. Refresh to check the actual device state.',busy:'Another device operation is in progress. Wait for it to finish, then try again.',disabled:'Simulator operation is off. Turn on the switch above first.',timeout:'No response from Baguette. Reopen the plugin page and check device status.',partial:'Operation is disabled, but some devices could not be confirmed shut down. Refresh and use Shut down for any remaining device.',settingsUnreadable:'Settings cannot be read. Starting and settings changes are blocked; you can still shut down devices. Restore the settings file, then refresh.',readFailed:'Could not read device status. Refresh to try again.',shutdownDone:'Device shut down. Apps and their connections have stopped.',previewNeedsSession:'Cindy needs an open conversation to display the viewer. Select a conversation and ask Baguette to open the view. Shutdown remains available here.',previewFailed:'The controls could not be opened. Refresh and try Open controls again.'},
  'zh-CN':{title:'我的模拟器',intro:'看见运行状态，随时自己关闭。',refresh:'刷新',allow:'允许运行模拟器',allowHint:'关闭后停止全部 Baguette 设备，并阻止 AI 再启动。重新打开开关不会自动开机。',idle:'闲置后自动关闭',m15:'15 分钟后',m30:'30 分钟后',m60:'1 小时后',manual:'仅手动关闭',idleHint:'操作设备或 AI 调用会重新计时；仅观看画面、刷新状态不会。关闭会结束 App 和连接，保留数据。',devices:'这台 Mac 上的设备',stopAll:'关闭全部设备',stopHint:'在 Cindy 中停用插件前，请先用这里的开关关闭设备。强制退出插件不保证设备已关机。关闭预览只关闭画面。',viewerTitle:'打开控制页后可做什么',viewerHint:'控制页可操作输入、旋转、摇动、安装 App 或文件，修改位置、运动、状态栏和网络条件，以及截图、录屏。摄像头和本机定位由你主动操作授权。地图搜索会访问 OpenStreetMap；复制粘贴会替换对应剪贴板。切换会关闭原设备、启动目标设备，并可能自动安装最近的应用包，替换目标上相同 bundleId 的 App；不会复制源 App 数据或凭证。设备变更和采集只在使用相应控件时执行。',checking:'正在检查设备…',paused:'运行许可已关闭，AI 无法启动设备。',running:'正在运行的设备：',stopped:'全部设备已关闭。',empty:'还没有 Baguette 设备，需要时可以让 Cindy 帮你准备。',boot:'启动设备',shutdown:'关闭设备',viewer:'打开控制页',booted:'运行中',off:'已关闭',busyState:'状态切换中',working:'正在处理…',saved:'已保存，设备数据保留。',failed:'尚未确认操作结果，请刷新查看设备实际状态。',busy:'设备正在执行其他操作，请等操作完成后再试。',disabled:'运行许可已关闭，请先打开上方开关。',timeout:'Baguette 未响应，请重新打开插件页并核对设备状态。',partial:'运行许可已关闭，但部分设备尚未确认关机。请刷新，并关闭仍在运行的设备。',settingsUnreadable:'无法读取设置，已禁止启动和修改设置；仍可关闭设备。请恢复设置文件后刷新。',readFailed:'未能读取设备状态，请点击刷新重试。',shutdownDone:'设备已关闭，其中的 App 和连接已停止。',previewNeedsSession:'Cindy 需要一个已打开的会话来显示画面。请进入会话，让 Baguette 打开画面；这里仍可直接关闭设备。',previewFailed:'控制页未能打开，请刷新后再点击“打开控制页”。'}
};
let T=text.en,state=null,busy=false,reading=false,readFailed=false;
const $=id=>document.getElementById(id), channel=new BroadcastChannel('baguette-settings'), pending=new Map();
function message(value,error=false){$('message').textContent=value;$('message').classList.toggle('error',error);}
async function rpc(action,params={}){
  // Logic pages start on demand; opening settings alone does not start one.
  const wake=await fetch('/wake',{signal:AbortSignal.timeout(15000)});
  if(!wake.ok)throw Error(T.timeout);
  const id=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const send=()=>channel.postMessage({type:'request',id,action,...params});
    // Only read-only status may retry while the listener becomes ready.
    // Never replay a device mutation after an uncertain response.
    const retry=action==='status'?setInterval(send,500):null;
    const timer=setTimeout(()=>{clearInterval(retry);pending.delete(id);reject(Error(T.timeout));},action==='status'?20000:125000);
    pending.set(id,{resolve,timer,retry});send();
  });
}
channel.onmessage=({data:m})=>{if(m?.type!=='response')return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);clearInterval(p.retry);p.resolve(m.result);};
function errorText(r){return ({BUSY:T.busy,RUNTIME_DISABLED:T.disabled,STOP_INCOMPLETE:T.partial,PREVIEW_FAILED:T.previewFailed,PREVIEW_NEEDS_SESSION:T.previewNeedsSession})[r?.errorCode]||T.failed;}
function render(){
  if(!state)return;
  const locked=busy||reading;
  if(!busy){$('enabled').checked=state.settings.enabled;$('idle').value=String(state.settings.idleMinutes);}
  $('enabled').disabled=locked||!!state.settingsError;$('idle').disabled=locked||!!state.settingsError;
  const running=state.devices.filter(d=>d.state!=='Shutdown').length;
  $('runtime').textContent=(state.settingsError?T.settingsUnreadable+' ':!state.settings.enabled?T.paused+' ':'')+(running?T.running+running:T.stopped);
  $('stop-all').disabled=locked||!running;
  const list=$('devices');list.replaceChildren();
  if(!state.devices.length){const empty=document.createElement('p');empty.textContent=T.empty;list.append(empty);}
  for(const device of state.devices){
    const row=document.createElement('div');row.className='device';
    const label=document.createElement('div'),name=document.createElement('div'),meta=document.createElement('div');
    name.className='device-name';name.textContent=device.name;meta.className='device-meta';
    meta.textContent=device.state==='Booted'?T.booted:device.state==='Shutdown'?T.off:T.busyState;
    label.append(name,meta);row.append(label);const actions=document.createElement('div');actions.className='actions';
    for(const action of device.state==='Shutdown'?['boot']:device.state==='Booted'?['viewer','shutdown']:['shutdown']){
      const button=document.createElement('button');button.textContent=T[action];button.disabled=locked||(action!=='shutdown'&&!state.settings.enabled);
      if(action==='shutdown')button.className='danger';button.onclick=()=>perform(action,{udid:device.udid});actions.append(button);
    }
    row.append(actions);list.append(row);
  }
}
async function refresh(){
  if(reading||busy)return;reading=true;$('refresh').disabled=true;render();
  try{const result=await rpc('status');if(!result.ok)throw Error(errorText(result));state=result;if(readFailed)message('');readFailed=false;render();}
  catch(e){readFailed=true;state=null;$('runtime').textContent=T.readFailed;$('enabled').disabled=$('idle').disabled=$('stop-all').disabled=true;$('devices').replaceChildren();message(e.message,true);}
  finally{reading=false;$('refresh').disabled=false;render();}
}
async function perform(action,params={}){
  if(busy)return;busy=true;render();message(T.working);
  try{const result=await rpc(action,params);if(result.settings&&result.devices)state=result;if(!result.ok)throw Error(errorText(result));message(action==='shutdown'||action==='stopAll'?T.shutdownDone:T.saved);}
  catch(e){message(e.message,true);}
  finally{busy=false;await refresh();render();}
}
$('enabled').onchange=()=>perform('save',{enabled:$('enabled').checked,idleMinutes:Number($('idle').value)});
$('idle').onchange=()=>perform('save',{enabled:$('enabled').checked,idleMinutes:Number($('idle').value)});
$('stop-all').onclick=()=>perform('stopAll');$('refresh').onclick=refresh;
(async()=>{
  try{const r=await(await fetch('/app-context')).json();T=text[r.context?.locale]||text.en;}catch{}
  document.documentElement.lang=T===text['zh-CN']?'zh-CN':'en';
  for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=T[el.dataset.i18n];
  $('runtime').textContent=T.checking;await refresh();
  setInterval(()=>{if(!document.hidden)refresh();},10000);
})();
