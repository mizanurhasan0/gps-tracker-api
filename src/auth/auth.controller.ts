import { Body, Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, UpdateProfileDto } from './auth.dto';
import { Public } from './auth.guard';
import { AuthRequest } from './auth.types';
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public()
  @Post('register')
  register(@Body() input: RegisterDto, @Req() req: AuthRequest) {
    this.auth.throttle(`register:${req.ip}`);
    return this.auth.register(input);
  }
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() input: LoginDto, @Req() req: AuthRequest) {
    this.auth.throttle(`login-ip:${req.ip}`);
    this.auth.throttle(`login-phone:${input.phone}`);
    return this.auth.login(input);
  }
  @Get('me') me(@Req() req: AuthRequest) {
    return req.user;
  }
  @Patch('me')
  updateProfile(@Body() input: UpdateProfileDto, @Req() req: AuthRequest) {
    return this.auth.updateProfile(req.user.id, input);
  }
  @Post('logout')
  @HttpCode(204)
  logout(@Req() req: AuthRequest) {
    return this.auth.logout(req.headers.authorization!.replace(/^Bearer /, ''));
  }
}
