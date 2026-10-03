#!/usr/bin/env node
// Anotify CLI 入口（骨架占位，完整命令设计见 DESIGN.md §7）
import { Command } from 'commander';

const program = new Command();

program
  .name('anotify')
  .description('Anotify: channel-based messaging for agents')
  .version('0.1.0');

program.parseAsync(process.argv);
