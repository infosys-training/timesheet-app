import React from 'react';
import { FiGithub, FiLinkedin, FiTwitter, FiCodepen, FiHeart } from 'react-icons/fi';
import './Footer.css';

const Footer = () => {
  const socialLinks = [
    { icon: <FiGithub />, url: 'https://github.com', label: 'GitHub' },
    { icon: <FiLinkedin />, url: 'https://linkedin.com', label: 'LinkedIn' },
    { icon: <FiTwitter />, url: 'https://twitter.com', label: 'Twitter' },
    { icon: <FiCodepen />, url: 'https://codepen.io', label: 'CodePen' },
  ];

  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__social">
          {socialLinks.map((link) => (
            <a
              key={link.label}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={link.label}
              className="footer__social-link"
            >
              {link.icon}
            </a>
          ))}
        </div>
        <p className="footer__text">
          Designed & Built by <span className="footer__highlight">Alex Morgan</span>
        </p>
        <p className="footer__subtext">
          Made with <FiHeart className="footer__heart" /> using React.js
        </p>
      </div>
    </footer>
  );
};

export default Footer;
