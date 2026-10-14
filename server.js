require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { connectDB } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const User = require('./models/User');
const seedDatabase = require('./utils/seed');
const { isAllowedOrigin } = require('./config/corsOrigin');

// Route imports
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const postRoutes = require('./routes/postRoutes');
const commentRoutes = require('./routes/commentRoutes');
const connectionRoutes = require('./routes/connectionRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const messageRoutes = require('./routes/messageRoutes');
const groupRoutes = require('./routes/groupRoutes');
const realtimeRoutes = require('./routes/realtimeRoutes');
const { cleanupAbandonedVideoUploads } = require('./controllers/videoUploadController');
const adminRoutes = require('./routes/adminRoutes');
const supportRoutes = require('./routes/supportRoutes');

const app = express();

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters in production.');
  }
}

// Initialize database and seed demo data only outside production unless explicitly requested.
const initApp = async () => {
  try {
    await connectDB();
    const count = await User.countDocuments();
    if (count === 0 && (process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO_DATA === 'true')) {
      console.log('[Server] Database is empty. Running initial auto-seed for demo experience...');
      // Run seed without process.exit
      const seedUsers = [
        {
          name: 'Elena Rostova',
          email: 'elena@nexora.io',
          password: 'password123',
          headline: 'VP of Product Design @ Stellaris AI | Ex-Airbnb Design Systems Lead',
          bio: 'Pioneering human-centered spatial computing and AI-assisted design systems. Passionate about craftsmanship, accessible typography, and building products that empower creativity. Speaker at Config & Awwwards.',
          location: 'San Francisco, CA',
          company: 'Stellaris AI',
          jobTitle: 'VP of Product Design',
          website: 'https://elenadesign.framer.media',
          profilePicture: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=500&auto=format&fit=crop&q=80',
          coverImage: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1200&auto=format&fit=crop&q=80',
          skills: ['Design Systems', 'Product Strategy', 'Figma', 'UX Architecture', 'Spatial UI', 'User Research'],
          experience: [
            {
              title: 'VP of Product Design',
              company: 'Stellaris AI',
              location: 'San Francisco, CA',
              startDate: '2023',
              endDate: 'Present',
              current: true,
              description: 'Leading a 30-person multidisciplinary product, brand, and design engineering team.'
            }
          ]
        },
        {
          name: 'Marcus Vance',
          email: 'marcus@nexora.io',
          password: 'password123',
          headline: 'Principal Distributed Systems Architect @ CloudScale | Go & Rust Evangelist',
          bio: 'Building resilient low-latency backend infrastructure handling 100M+ requests per second. Open source contributor to Kubernetes and Tokio.',
          location: 'Seattle, WA',
          company: 'CloudScale Technologies',
          jobTitle: 'Principal Systems Architect',
          website: 'https://marcusvance.dev',
          profilePicture: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=500&auto=format&fit=crop&q=80',
          coverImage: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1200&auto=format&fit=crop&q=80',
          skills: ['Distributed Systems', 'Rust', 'Go', 'Kubernetes', 'High Throughput DBs', 'Kafka'],
          experience: [
            {
              title: 'Principal Systems Architect',
              company: 'CloudScale Technologies',
              location: 'Seattle, WA',
              startDate: '2021',
              endDate: 'Present',
              current: true,
              description: 'Architecting ultra-low latency global data meshes.'
            }
          ]
        },
        {
          name: 'Dr. Anya Sharma',
          email: 'anya@nexora.io',
          password: 'password123',
          headline: 'Chief AI Scientist @ Cognition Lab | PhD Oxford | Large Multimodal Models',
          bio: 'Researching reasoning topologies, multimodal tokenization, and alignment for frontier models. Author of 18+ papers across NeurIPS and ICML.',
          location: 'London, UK',
          company: 'Cognition Lab',
          jobTitle: 'Chief AI Scientist',
          website: 'https://anyasharma.ai',
          profilePicture: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=500&auto=format&fit=crop&q=80',
          coverImage: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=1200&auto=format&fit=crop&q=80',
          skills: ['Deep Learning', 'PyTorch', 'Transformers', 'Multimodal LLMs', 'AI Safety']
        },
        {
          name: 'Devon Thorne',
          email: 'devon@nexora.io',
          password: 'password123',
          headline: 'Co-Founder & CEO @ Nexus Robotics | Forbes 30 Under 30',
          bio: 'Scaling autonomous warehouse robotics. Obsessed with high velocity execution, radical transparency, and building products customers love.',
          location: 'Austin, TX',
          company: 'Nexus Robotics',
          jobTitle: 'Co-Founder & CEO',
          website: 'https://nexusrobotics.tech',
          profilePicture: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=500&auto=format&fit=crop&q=80',
          coverImage: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=1200&auto=format&fit=crop&q=80',
          skills: ['Venture Capital', 'Product Leadership', 'Robotics', 'Growth']
        }
      ];

      const Post = require('./models/Post');
      const Comment = require('./models/Comment');
      const Connection = require('./models/Connection');
      const Notification = require('./models/Notification');

      const created = [];
      for (const u of seedUsers) {
        created.push(await User.create(u));
      }

      // Mutual connections
      await Connection.create({ requester: created[0]._id, recipient: created[1]._id, status: 'accepted' });
      await Connection.create({ requester: created[0]._id, recipient: created[2]._id, status: 'accepted' });
      await Connection.create({ requester: created[0]._id, recipient: created[3]._id, status: 'accepted' });

      await User.findByIdAndUpdate(created[0]._id, { $addToSet: { connections: [created[1]._id, created[2]._id, created[3]._id] } });
      await User.findByIdAndUpdate(created[1]._id, { $addToSet: { connections: [created[0]._id] } });
      await User.findByIdAndUpdate(created[2]._id, { $addToSet: { connections: [created[0]._id] } });
      await User.findByIdAndUpdate(created[3]._id, { $addToSet: { connections: [created[0]._id] } });

      const samplePost1 = await Post.create({
        author: created[0]._id,
        content: 'Thrilled to announce that our new design system at Stellaris AI is now fully operational! 🚀\n\nWe spent 6 months re-thinking how design tokens interact with autonomous UI generation. Instead of static components, our interface dynamically adapts density and contrast.\n\n#designsystems #ux #ai #productdesign',
        image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1000&auto=format&fit=crop&q=80',
        likes: [created[1]._id, created[2]._id],
        tags: ['designsystems', 'ux', 'ai', 'productdesign']
      });

      const samplePost2 = await Post.create({
        author: created[1]._id,
        content: 'Hot take: Simplicity is the hardest architectural virtue to achieve in distributed systems.\n\nOver the past quarter, we consolidated 40% of microservices into modular Go monoliths, dropping latency by 65%.\n\n#distributedsystems #golang #cloud',
        image: 'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=1000&auto=format&fit=crop&q=80',
        likes: [created[0]._id, created[3]._id],
        tags: ['distributedsystems', 'golang', 'cloud']
      });

      const comment1 = await Comment.create({
        post: samplePost1._id,
        author: created[1]._id,
        content: 'Fascinating perspective! Would love to dive deeper into how this impacts latency under high concurrency.'
      });

      samplePost1.comments.push(comment1._id);
      await samplePost1.save();

      await Notification.create({
        recipient: created[0]._id,
        sender: created[1]._id,
        type: 'post_like',
        post: samplePost1._id,
        message: 'Marcus Vance liked your post about the new design system.'
      });

      await Notification.create({
        recipient: created[0]._id,
        sender: created[2]._id,
        type: 'post_comment',
        post: samplePost1._id,
        message: 'Dr. Anya Sharma commented on your post.'
      });

      console.log('[Server] Initial auto-seed completed successfully!');
    }
  } catch (err) {
    console.error('[Server] Init error:', err.message);
  }
};

initApp();
const videoCleanupTimer = setInterval(() => {
  cleanupAbandonedVideoUploads().catch(() => {});
}, 60 * 60 * 1000);
videoCleanupTimer.unref();
setTimeout(() => cleanupAbandonedVideoUploads().catch(() => {}), 30_000).unref();

// CORS Configuration
app.use(cors({
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    console.warn(`[CORS Blocked] Origin: ${origin}`);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Static directory for uploaded assets
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Root / Health check endpoint (Handles GET and HEAD for Render health checks)
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Vuprise API is running',
    status: 'ok'
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    timestamp: new Date().toISOString(),
    service: 'Vuprise Professional Networking API',
    version: '1.0.0',
    commit: /^[0-9a-f]{40}$/i.test(process.env.RENDER_GIT_COMMIT || '')
      ? process.env.RENDER_GIT_COMMIT
      : null,
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/posts', postRoutes);
// Comments are nested under posts for create/list operations (the client calls
// /api/posts/:postId/comments). Keep the standalone mount for comment deletion.
app.use('/api/posts', commentRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/realtime', realtimeRoutes);

// Error Handling Middlewares
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 VUPRISE Server running on port http://localhost:${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`======================================================\n`);
});

process.on('unhandledRejection', (err) => {
  console.error(`Unhandled Rejection Error: ${err.message}`);
});

module.exports = app;
