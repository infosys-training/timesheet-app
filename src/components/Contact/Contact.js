import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { FiMail, FiMapPin, FiPhone, FiSend } from 'react-icons/fi';
import './Contact.css';

const Contact = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    subject: '',
    message: '',
  });

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const mailtoLink = `mailto:alex.morgan@email.com?subject=${encodeURIComponent(formData.subject)}&body=${encodeURIComponent(`Name: ${formData.name}\nEmail: ${formData.email}\n\n${formData.message}`)}`;
    window.location.href = mailtoLink;
  };

  return (
    <section className="contact section" id="contact">
      <div className="container">
        <h2 className="section-heading">
          <span className="number">06.</span> Get In Touch
        </h2>

        <div className="contact__grid">
          <motion.div
            className="contact__info"
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <h3 className="contact__info-title">Let's Work Together</h3>
            <p className="contact__info-text">
              I'm always interested in hearing about new projects and
              opportunities. Whether you have a question or just want to say hi,
              my inbox is always open. I'll do my best to get back to you
              promptly!
            </p>

            <div className="contact__details">
              <div className="contact__detail">
                <div className="contact__detail-icon">
                  <FiMail />
                </div>
                <div>
                  <p className="contact__detail-label">Email</p>
                  <a href="mailto:alex.morgan@email.com" className="contact__detail-value">
                    alex.morgan@email.com
                  </a>
                </div>
              </div>
              <div className="contact__detail">
                <div className="contact__detail-icon">
                  <FiMapPin />
                </div>
                <div>
                  <p className="contact__detail-label">Location</p>
                  <p className="contact__detail-value">San Francisco, CA</p>
                </div>
              </div>
              <div className="contact__detail">
                <div className="contact__detail-icon">
                  <FiPhone />
                </div>
                <div>
                  <p className="contact__detail-label">Phone</p>
                  <p className="contact__detail-value">+1 (555) 123-4567</p>
                </div>
              </div>
            </div>

            <div className="contact__availability">
              <div className="contact__availability-dot" />
              <span>Currently available for freelance work</span>
            </div>
          </motion.div>

          <motion.form
            className="contact__form"
            onSubmit={handleSubmit}
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <div className="contact__form-row">
              <div className="contact__form-group">
                <label htmlFor="name" className="contact__form-label">Name</label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="John Doe"
                  required
                  className="contact__form-input"
                />
              </div>
              <div className="contact__form-group">
                <label htmlFor="email" className="contact__form-label">Email</label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  placeholder="john@example.com"
                  required
                  className="contact__form-input"
                />
              </div>
            </div>
            <div className="contact__form-group">
              <label htmlFor="subject" className="contact__form-label">Subject</label>
              <input
                type="text"
                id="subject"
                name="subject"
                value={formData.subject}
                onChange={handleChange}
                placeholder="Project Inquiry"
                required
                className="contact__form-input"
              />
            </div>
            <div className="contact__form-group">
              <label htmlFor="message" className="contact__form-label">Message</label>
              <textarea
                id="message"
                name="message"
                value={formData.message}
                onChange={handleChange}
                placeholder="Tell me about your project..."
                required
                rows="5"
                className="contact__form-textarea"
              />
            </div>
            <button type="submit" className="btn btn-filled contact__form-btn">
              <FiSend className="contact__form-btn-icon" />
              Send Message
            </button>
          </motion.form>
        </div>
      </div>
    </section>
  );
};

export default Contact;
