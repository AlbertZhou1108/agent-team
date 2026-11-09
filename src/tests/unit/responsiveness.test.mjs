import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeResponsiveness } from '../../responsiveness.mjs';
test('slow request diagnostics omit query secrets and record once', () => {
 const rows=[]; const monitor=observeResponsiveness('.', {slowMs:0,write:row=>rows.push(row)});
 try {const response=new EventEmitter();response.statusCode=200;response.writableFinished=true;
 monitor.request({url:'/api/snapshot?secret=private',method:'GET'},response);
 response.emit('finish');response.emit('close');
 assert.equal(rows.length,1);assert.equal(rows[0].path,'/api/snapshot');assert.equal(rows[0].completed,true);
 const stream=new EventEmitter();monitor.request({url:'/api/panel-agent/events',method:'GET'},stream);stream.emit('close');assert.equal(rows.length,1);
 } finally {monitor.close()}
});
