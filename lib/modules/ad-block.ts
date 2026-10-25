import type { Module } from '../modules';
import vaftSupport from './vaft-support';
import vaftTimer from './vaft-timer';

// Two edited copies of vaft; the popup's Version option picks one.
const adBlock: Module = (options) => (options.version === 'timer' ? vaftTimer : vaftSupport)(options);

export default adBlock;
