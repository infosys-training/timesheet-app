import React, { useState, useEffect } from 'react';
import { Link } from 'react-scroll';
import { FiMenu, FiX } from 'react-icons/fi';
import './Navbar.css';

const Navbar = () => {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navLinks = [
    { name: 'About', to: 'about' },
    { name: 'Skills', to: 'skills' },
    { name: 'Projects', to: 'projects' },
    { name: 'Experience', to: 'experience' },
    { name: 'Testimonials', to: 'testimonials' },
    { name: 'Contact', to: 'contact' },
  ];

  const toggleMenu = () => setMenuOpen(!menuOpen);
  const closeMenu = () => setMenuOpen(false);

  return (
    <nav className={`navbar ${scrolled ? 'navbar--scrolled' : ''}`}>
      <div className="navbar__container">
        <Link to="hero" smooth duration={500} className="navbar__logo" onClick={closeMenu}>
          <span className="navbar__logo-bracket">&lt;</span>
          {'AM'}
          <span className="navbar__logo-bracket">{' />'}</span>
        </Link>

        <div className={`navbar__menu ${menuOpen ? 'navbar__menu--open' : ''}`}>
          <ul className="navbar__links">
            {navLinks.map((link, index) => (
              <li key={link.name} className="navbar__item">
                <Link
                  to={link.to}
                  smooth
                  duration={500}
                  offset={-70}
                  className="navbar__link"
                  activeClass="navbar__link--active"
                  spy
                  onClick={closeMenu}
                >
                  <span className="navbar__link-number">0{index + 1}.</span>
                  {link.name}
                </Link>
              </li>
            ))}
          </ul>
          <a
            href="/resume.pdf"
            className="btn navbar__resume-btn"
            target="_blank"
            rel="noopener noreferrer"
          >
            Resume
          </a>
        </div>

        <button className="navbar__toggle" onClick={toggleMenu} aria-label="Toggle menu">
          {menuOpen ? <FiX /> : <FiMenu />}
        </button>
      </div>
    </nav>
  );
};

export default Navbar;
