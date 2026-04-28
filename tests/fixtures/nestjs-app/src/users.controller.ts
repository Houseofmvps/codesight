import { Controller, Get, Post, Put, Delete, Param } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }
  @Get(':id')
  findOne(@Param('id') id: string) { return {}; }
  @Post()
  create() { return {}; }
  @Delete(':id')
  remove(@Param('id') id: string) { return {}; }
}