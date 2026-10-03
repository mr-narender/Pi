export default function ownedLifecycleVeto(pi) {
  pi.on('session_before_switch', () => ({ cancel: true }));
  pi.on('session_before_fork', () => ({ cancel: true }));
  pi.on('session_before_tree', () => ({ cancel: true }));
  pi.on('session_shutdown', () => {
    throw new Error('owned disposal failure');
  });
}
