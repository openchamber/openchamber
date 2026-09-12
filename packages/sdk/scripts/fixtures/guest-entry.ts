import { connectHost } from '../../src/index.ts';

const host = connectHost();
void host.toast({ kind: 'info', message: 'HELLO-1' });
