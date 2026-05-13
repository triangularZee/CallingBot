import { parseArgs, requireArg } from '../utils/args.js';
import { dialConference } from './twilioCallBot.js';

const args = parseArgs();
const to = requireArg(args, 'to');
const digits = args.digits ? String(args.digits) : '';
const title = args.title ? String(args.title) : 'phone-conference';

const call = await dialConference({ to, digits, title });
console.log(JSON.stringify({
  sid: call.sid,
  status: call.status,
  to,
  title
}, null, 2));
