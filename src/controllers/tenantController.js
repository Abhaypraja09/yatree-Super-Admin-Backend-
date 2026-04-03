const asyncHandler = require('express-async-handler');
const Tenant = require('../models/Tenant');
const Company = require('../models/Company');
const User = require('../models/User');
const Vehicle = require('../models/Vehicle');

// @desc    Get all tenants
// @route   GET /api/tenants
// @access  Private (Super Admin)
const getTenants = asyncHandler(async (req, res) => {
    const tenants = await Tenant.find({}).sort({ createdAt: -1 }).lean();
    
    // 🛡️ ENHANCEMENT: Populate LIVE counts from main database for each tenant
    const enhancedTenants = await Promise.all(tenants.map(async (tenant) => {
        if (tenant.companyId) {
            // Count total internal (non-outside) vehicles for this company
            const vCount = await Vehicle.countDocuments({ 
                company: tenant.companyId,
                isOutsideCar: false 
            });
            
            // Count total Drivers for this company
            const dCount = await User.countDocuments({
                company: tenant.companyId,
                role: 'Driver'
            });

            return { ...tenant, vehicleCount: vCount, driverCount: dCount };
        }
        return tenant;
    }));

    res.json(enhancedTenants);
});

// @desc    Get single tenant detail
// @route   GET /api/tenants/:id
// @access  Private (Super Admin)
const getTenantById = asyncHandler(async (req, res) => {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) {
        res.status(404);
        throw new Error('Tenant not found');
    }
    res.json(tenant);
});

// @desc    Create new tenant (Software Instance)
// @route   POST /api/tenants
// @access  Private (Super Admin)
const createTenant = asyncHandler(async (req, res) => {
    console.log('--- CREATE TENANT DEBUG ---');
    console.log('REQ BODY:', req.body);
    console.log('REQ FILES:', req.files);

    let {
        companyName, ownerName, phone,
        adminEmail, adminPassword, plan, monthlyFee,
        trialDays, permissions, vehicleLimit, website
    } = req.body;

    // Handle permissions if it's a string from FormData
    if (typeof permissions === 'string') {
        try {
            permissions = JSON.parse(permissions);
        } catch (e) {
            console.error('Failed to parse permissions:', e);
        }
    }

    // Ensure numbers are numbers
    monthlyFee = Number(monthlyFee) || 0;
    vehicleLimit = Number(vehicleLimit) || 10;
    trialDays = Number(trialDays) || 0;

    // Use uploaded files if present, otherwise fallback to req.body.logo/signature (standard URLs)
    let logoUrl = req.body.logo || '';
    let signatureUrl = req.body.signature || '';

    if (req.files) {
        if (req.files.logo && req.files.logo[0]) {
            logoUrl = `${req.protocol}://${req.get('host')}/uploads/${req.files.logo[0].filename}`;
        }
        if (req.files.signature && req.files.signature[0]) {
            signatureUrl = `${req.protocol}://${req.get('host')}/uploads/${req.files.signature[0].filename}`;
        }
    }
    
    // Default email to adminEmail if not provided
    const email = req.body.email || adminEmail;

    if (!companyName || !adminEmail || !adminPassword) {
        res.status(400);
        throw new Error('Company Name, Admin Email and Password are required for setup');
    }

    // 1. Find or Create Company record in main DB
    let company = await Company.findOne({ name: { $regex: new RegExp(`^${companyName.trim()}$`, 'i') } });
    if (company) {
        company.status = 'active';
        company.vehicleLimit = Number(vehicleLimit) || company.vehicleLimit || 10;
        company.website = website || company.website || '';
        company.logoUrl = logoUrl || company.logoUrl || '';
        company.ownerSignatureUrl = signatureUrl || company.ownerSignatureUrl || '';
        company.ownerName = ownerName || company.ownerName || '';
        await company.save();
    } else {
        company = await Company.create({
            name: companyName,
            status: 'active',
            vehicleLimit: Number(vehicleLimit) || 10,
            website: website || '',
            logoUrl: logoUrl,
            ownerSignatureUrl: signatureUrl,
            ownerName: ownerName || ''
        });
    }

    // 2. Find or Create Admin User record in main DB
    let user = await User.findOne({ username: adminEmail });
    if (user) {
        user.name = ownerName || user.name;
        user.mobile = phone || user.mobile;
        user.password = adminPassword; // Hashing will trigger on save
        user.company = company._id;
        user.status = 'active';
        user.role = 'Admin';
        user.vehicleLimit = Number(vehicleLimit) || user.vehicleLimit || 10;
        if (permissions) user.permissions = permissions;
        await user.save();
    } else {
        user = await User.create({
            name: ownerName || 'Admin',
            mobile: phone || '0000000000',
            username: adminEmail,
            password: adminPassword,
            role: 'Admin',
            company: company._id,
            status: 'active',
            vehicleLimit: Number(vehicleLimit) || 10,
            permissions: permissions || {
                dashboard: true,
                liveFeed: true,
                logBook: true,
                driversService: true,
                buySell: true,
                vehiclesManagement: true,
                fleetOperations: true,
                reports: true,
                staffManagement: true,
                manageAdmins: true
            }
        });
    }

    // 3. Find or Create Tenant tracking record
    let tenant = await Tenant.findOne({ $or: [{ email }, { companyId: company._id }] });
    
    // Initialize expiration dates
    let trialEndsAt = null;
    let expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 1);

    if (trialDays && trialDays > 0) {
        trialEndsAt = new Date();
        trialEndsAt.setDate(trialEndsAt.getDate() + Number(trialDays));
    }

    if (tenant) {
        // Update existing tenant
        tenant.companyName = companyName;
        tenant.ownerName = ownerName || tenant.ownerName;
        tenant.email = email;
        tenant.phone = phone || tenant.phone;
        tenant.adminEmail = adminEmail;
        tenant.adminPassword = adminPassword;
        tenant.plan = plan || tenant.plan;
        tenant.monthlyFee = Number(monthlyFee) || tenant.monthlyFee;
        tenant.status = 'active';
        tenant.companyId = company._id;
        tenant.adminUserId = user._id;
        tenant.vehicleLimit = Number(vehicleLimit) || tenant.vehicleLimit || 10;
        tenant.website = website || tenant.website || '';
        tenant.logo = logoUrl || tenant.logo || '';
        tenant.signature = signatureUrl || tenant.signature || '';
        if (permissions) tenant.permissions = permissions;
        await tenant.save();
    } else {
        tenant = await Tenant.create({
            companyName,
            ownerName: ownerName || 'Admin',
            email,
            phone: phone || '0000000000',
            adminEmail,
            adminPassword,
            plan: plan || 'trial',
            status: plan === 'trial' ? 'trial' : 'active',
            trialEndsAt,
            expiresAt,
            monthlyFee: Number(monthlyFee) || 0,
            vehicleLimit: Number(vehicleLimit) || 10,
            website: website || '',
            logo: logoUrl,
            signature: signatureUrl,
            companyId: company._id,
            adminUserId: user._id,
            permissions: permissions || {
                dashboard: true,
                liveFeed: true,
                logBook: true,
                driversService: true,
                buySell: true,
                vehiclesManagement: true,
                fleetOperations: true,
                reports: true,
                staffManagement: true,
                manageAdmins: true
            }
        });
    }

    res.status(201).json(tenant);
});

// @desc    Update tenant
// @route   PUT /api/tenants/:id
// @access  Private (Super Admin)
const updateTenant = asyncHandler(async (req, res) => {
    const tenant = await Tenant.findById(req.params.id);

    if (tenant) {
        // Construct URLs for logo and signature if files uploaded
        let logoUrl = req.body.logo ?? tenant.logo;
        let signatureUrl = req.body.signature ?? tenant.signature;

        if (req.files) {
            if (req.files.logo && req.files.logo[0]) {
                logoUrl = `${req.protocol}://${req.get('host')}/uploads/${req.files.logo[0].filename}`;
            }
            if (req.files.signature && req.files.signature[0]) {
                signatureUrl = `${req.protocol}://${req.get('host')}/uploads/${req.files.signature[0].filename}`;
            }
        }

        let permissions = req.body.permissions;
        if (typeof permissions === 'string') {
            try {
                permissions = JSON.parse(permissions);
            } catch (e) {
                console.error('Failed to parse update permissions:', e);
            }
        }

        tenant.companyName = req.body.companyName || tenant.companyName;
        tenant.ownerName = req.body.ownerName || tenant.ownerName;
        tenant.status = req.body.status || tenant.status;
        tenant.plan = req.body.plan || tenant.plan;
        tenant.monthlyFee = req.body.monthlyFee ?? Number(tenant.monthlyFee);
        tenant.vehicleLimit = Number(req.body.vehicleLimit) || tenant.vehicleLimit;
        tenant.website = req.body.website ?? tenant.website;
        tenant.logo = logoUrl;
        tenant.signature = signatureUrl;
        tenant.expiresAt = req.body.expiresAt || tenant.expiresAt;

        // 🛡️ SYNC: Update the actual Admin User record if email or password changed
        if (tenant.adminUserId) {
            const user = await User.findById(tenant.adminUserId);
            if (user) {
                if (req.body.adminEmail) {
                    user.username = req.body.adminEmail;
                    tenant.adminEmail = req.body.adminEmail;
                }
                if (req.body.adminPassword) {
                    user.password = req.body.adminPassword; // This will be hashed by User model pre-save
                    tenant.adminPassword = req.body.adminPassword; // Keep plain text in Tenant for SA display
                }
                if (permissions) {
                    user.permissions = permissions;
                    tenant.permissions = permissions;
                }
                if (req.body.vehicleLimit || req.body.website || req.files || req.body.ownerName) {
                    user.vehicleLimit = Number(req.body.vehicleLimit) || user.vehicleLimit;
                    // Also update company record
                    if (tenant.companyId) {
                        await Company.findByIdAndUpdate(tenant.companyId, { 
                            vehicleLimit: Number(req.body.vehicleLimit) || tenant.vehicleLimit,
                            website: req.body.website ?? tenant.website,
                            logoUrl: logoUrl,
                            ownerSignatureUrl: signatureUrl,
                            ownerName: req.body.ownerName ?? tenant.ownerName
                        });
                    }
                }
                await user.save();
            }
        }

        const updatedTenant = await tenant.save();
        res.json(updatedTenant);
    } else {
        res.status(404);
        throw new Error('Tenant not found');
    }
});

// @desc    Delete tenant (Warning: Data removal)
// @route   DELETE /api/tenants/:id
// @access  Private (Super Admin)
const deleteTenant = asyncHandler(async (req, res) => {
    const tenant = await Tenant.findById(req.params.id);

    if (tenant) {
        // Option to delete company/user as well if requested
        // For security, just delete the tenant tracking record and mark company as suspended
        if (tenant.companyId) {
            await Company.findByIdAndUpdate(tenant.companyId, { status: 'suspended' });
        }

        await tenant.deleteOne();
        res.json({ message: 'Tenant record removed and client suspended' });
    } else {
        res.status(404);
        throw new Error('Tenant not found');
    }
});

module.exports = {
    getTenants,
    getTenantById,
    createTenant,
    updateTenant,
    deleteTenant
};