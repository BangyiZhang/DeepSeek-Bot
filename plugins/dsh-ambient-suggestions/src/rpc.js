// Hand-written strict Remote contribution based on packaged DSH createTypertRemoteInfo.
import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

export const PACKAGE = 'dsh-ambient-suggestions';
const request = () => z.strictObject({sessionId:z.string(),turnKey:z.string(),language:z.string().optional()});
const preferences = () => z.strictObject({model:z.string(),groups:z.array(z.strictObject({id:z.string(),label:z.string(),models:z.array(z.strictObject({id:z.string(),name:z.string()}))}))});
const codec = (name, create) => ({mode:'strict',typeSymbol:`${PACKAGE}#${name}`,create});
const requestCodec = codec('PredictionRequest', request);
export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: PACKAGE,
  methods: {
    'ambientSuggestions/predict': {
      service: 'ambientSuggestions',
      invocation: {kind:'direct'},
      parameters: [{name:'request',source:'json',codec:requestCodec,strictCodec:requestCodec}],
      cancellation: {parameter:'signal'},
      result: codec('Prediction', () => z.string()),
    },
    'ambientSuggestions/preferences': {
      service: 'ambientSuggestions',
      invocation: {kind:'direct'},
      parameters: [],
      cancellation: {parameter:'signal'},
      result: codec('Preferences', preferences),
    },
  },
}, z);

// Choose EITHER manual ctx.typert.register(TYPERT) in the host service
// OR a package ./typert export discovered by dsh-typert-loader, never both.
export const TYPERT_HOST = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  model: {services:[],events:[],objects:[]},
  get invocations() { return TYPERT_REMOTE.descriptors; },
};
