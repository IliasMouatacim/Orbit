const status = document.querySelector<HTMLParagraphElement>('#status')!;
function openChat() {
  if (navigator.onLine) {
    window.location.assign('https://chattingapp-kappa.vercel.app/');
  } else {
    status.textContent = 'You are offline. Connect to the internet, then open chat.';
  }
}
document.querySelector('#open')!.addEventListener('click', openChat);
window.addEventListener('online', openChat);
openChat();
export {};
