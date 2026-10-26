#!/usr/bin/env node
import { connect } from '#vue-mapper';

const connection = connect((chunk) => process.stdout.write(chunk));
process.stdin.on('data', (chunk: Buffer) => connection.receive(chunk));
process.stdin.on('end', () => process.exit(0));
