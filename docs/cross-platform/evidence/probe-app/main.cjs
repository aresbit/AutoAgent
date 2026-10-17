const { app, BrowserWindow } = require('electron');
const t0 = Date.now();
const mark = (m) => console.error(`[probe] +${Date.now()-t0}ms ${m}`);
if (process.env.TEST_INPROC === '1') { app.commandLine.appendSwitch('in-process-gpu'); mark('in-process-gpu set'); }
app.whenReady().then(() => {
  mark('ready');
  const w = new BrowserWindow({ show: true, width: 640, height: 480 });
  w.loadURL('data:text/html,<h1>probe</h1><canvas id=c width=600 height=400></canvas><script>const c=document.getElementById("c"),x=c.getContext("2d");let i=0;setInterval(()=>{x.fillStyle=`hsl(${i++%360},80%,50%)`;x.fillRect(0,0,600,400)},50)</script>');
  w.webContents.on('did-finish-load', () => mark('did-finish-load'));
  w.once('ready-to-show', () => mark('ready-to-show'));
});
